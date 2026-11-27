import type { AgentIndex, AgentSnapshot } from "./agents";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { createDatabasePool } from "./platform-db";
import { REFERENCE, type InsightDay, type Sample } from "./insights";

export type SampleDay = { samples: Record<string, Sample>; updatedAt: string };
export type IndexedSample = { participant: string; id: string; sample: Sample; receivedAt: string };
/** One UTC partition: a revision that changes whenever its samples change, plus coverage bounds. */
export type SourceDay = {
  day: string;
  revision: string;
  first: number;
  last: number;
  /** Earliest and latest instants any sample in this partition can cover. */
  start: number;
  end: number;
};
/** A finished local-day summary, valid while `stamp` matches its source partitions. */
export type CachedSummary = { day: string; stamp: string; summary: InsightDay | null };
export interface SummaryRollups {
  sourceDays(participant: string): Promise<SourceDay[]>;
  readSummaries(
    participant: string,
    timeZone: string,
    days: string[],
  ): Promise<Map<string, CachedSummary>>;
  writeSummaries(participant: string, timeZone: string, rows: CachedSummary[]): Promise<void>;
}
export interface AnalyticsIndex extends AgentIndex, Partial<SummaryRollups> {
  /** One trivial round trip, for latency diagnostics. */
  ping?(): Promise<void>;
  readonly key: string;
  write(rows: IndexedSample[]): Promise<void>;
  page(
    participant: string,
    cursor: string,
    limit: number,
  ): Promise<{ days: string[]; nextCursor: string; historyStart: number | null }>;
  read(participant: string, from: string, to: string): Promise<Map<string, SampleDay>>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}
type Row = Sample & { id: string; day: string; receivedAt: number | string };
const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(value)) throw Error("Invalid analytics database identifier");
  return value;
};
// Matches summarize(): each sample covers at most half its clamped interval on either side.
const HALF = `LEAST(300,GREATEST(15,COALESCE(NULLIF(sample_interval,0),60)))/2`;
const DAY_AGGREGATES = `count(*),min(sample_date),max(sample_date),min(sample_date-${HALF}),max(sample_date+${HALF})`;
const partition = (sample: Sample) =>
  new Date((sample.date + REFERENCE) * 1000).toISOString().slice(0, 10);
const fingerprint = (kind: string, destination: string) =>
  kind + "-" + createHash("sha256").update(destination).digest("hex").slice(0, 16);
function collect(rows: Row[]) {
  const days = new Map<string, SampleDay>();
  for (const row of rows) {
    const updatedAt = new Date(Number(row.receivedAt)).toISOString();
    const day = days.get(row.day) ?? { samples: {}, updatedAt };
    day.samples[row.id] = {
      date: row.date,
      interval: row.interval,
      app: row.app || undefined,
      appID: row.appID || undefined,
      activity: row.activity || undefined,
      project: row.project || undefined,
    };
    if (updatedAt > day.updatedAt) day.updatedAt = updatedAt;
    days.set(row.day, day);
  }
  return days;
}
function pageResult(days: string[], limit: number, historyStart: number | null) {
  return {
    days: days.slice(0, limit),
    nextCursor: days.length > limit ? days[limit - 1] : "",
    historyStart,
  };
}
export class PostgresAnalytics implements AnalyticsIndex {
  readonly key: string;
  private pool: Pool;
  private table: string;
  private days: string;
  private summaries: string;
  constructor(
    url: string,
    private schema = "breadcrumb_analytics",
  ) {
    identifier(schema);
    const destination = new URL(url);
    destination.password = "";
    destination.username = "";
    this.key = fingerprint("postgres", destination.href + schema);
    this.table = `"${schema}".samples`;
    this.days = `"${schema}".days`;
    this.summaries = `"${schema}".summaries`;
    this.pool = createDatabasePool(url, { max: 2 });
  }
  async migrate() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS "${this.schema}".agent_hours (participant text NOT NULL,source text NOT NULL,hour timestamptz NOT NULL,revision bigint NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(participant,source,hour))`,
    );
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      participant text NOT NULL, id text NOT NULL, day text NOT NULL,
      sample_date double precision NOT NULL, sample_interval double precision NOT NULL,
      app text NOT NULL, app_id text NOT NULL, activity text NOT NULL, project text NOT NULL,
      received_at timestamptz NOT NULL, PRIMARY KEY (participant,id)
    )`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS samples_by_day ON ${this.table} (participant,day,sample_date)`,
    );
    await this.pool.query(`CREATE SEQUENCE IF NOT EXISTS "${this.schema}".day_revision`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.days} (
      participant text NOT NULL, day text NOT NULL, revision bigint NOT NULL,
      samples integer NOT NULL, first_sample double precision NOT NULL,
      last_sample double precision NOT NULL, first_edge double precision NOT NULL,
      last_edge double precision NOT NULL, PRIMARY KEY (participant,day)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.summaries} (
      participant text NOT NULL, time_zone text NOT NULL, day text NOT NULL,
      stamp text NOT NULL, summary jsonb, computed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (participant,time_zone,day)
    )`);
    // Index samples written before rollups existed. Later writes maintain these rows.
    await this.pool.query(
      `INSERT INTO ${this.days} (participant,day,revision,samples,first_sample,last_sample,first_edge,last_edge)
      SELECT participant,day,nextval('"${this.schema}".day_revision'),${DAY_AGGREGATES}
      FROM ${this.table} GROUP BY participant,day ON CONFLICT DO NOTHING`,
    );
  }
  async writeAgents(participant: string, snapshots: AgentSnapshot[]) {
    for (const snapshot of snapshots)
      await this.pool.query(
        `INSERT INTO "${this.schema}".agent_hours AS current (participant,source,hour,revision,snapshot) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (participant,source,hour) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot WHERE excluded.revision>current.revision`,
        [participant, snapshot.source, snapshot.hour, snapshot.revision, JSON.stringify(snapshot)],
      );
  }
  async readAgents(participant: string, from: string, to: string) {
    const rows = await this.pool.query<{ snapshot: AgentSnapshot }>(
      `SELECT snapshot FROM "${this.schema}".agent_hours WHERE participant=$1 AND hour BETWEEN $2 AND $3 ORDER BY hour`,
      [participant, from, to],
    );
    return rows.rows.map((r) => r.snapshot);
  }
  async write(rows: IndexedSample[]) {
    if (!rows.length) return;
    const values: unknown[] = [];
    const placeholders = rows.map(({ participant, id, sample: s, receivedAt }) => {
      const offset = values.length;
      values.push(
        participant,
        id,
        partition(s),
        s.date,
        s.interval,
        s.app ?? "",
        s.appID ?? "",
        s.activity ?? "",
        s.project ?? "",
        receivedAt,
      );
      return "(" + Array.from({ length: 10 }, (_, i) => `$${offset + i + 1}`).join(",") + ")";
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize each participant's writes so day aggregates and revisions never interleave.
      for (const participant of [...new Set(rows.map((r) => r.participant))].sort())
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "breadcrumb-analytics:" + participant,
        ]);
      const previous = await client.query<{ participant: string; id: string; day: string }>(
        `SELECT participant,id,day FROM ${this.table} WHERE (participant,id) IN (SELECT * FROM unnest($1::text[],$2::text[]))`,
        [rows.map((r) => r.participant), rows.map((r) => r.id)],
      );
      const changed = await client.query<{ participant: string; id: string; day: string }>(
        `INSERT INTO ${this.table} AS current (participant,id,day,sample_date,sample_interval,app,app_id,activity,project,received_at)
        VALUES ${placeholders.join(",")} ON CONFLICT (participant,id) DO UPDATE SET
        day=excluded.day,sample_date=excluded.sample_date,sample_interval=excluded.sample_interval,
        app=excluded.app,app_id=excluded.app_id,activity=excluded.activity,project=excluded.project,
        received_at=GREATEST(current.received_at,excluded.received_at)
        WHERE ROW(current.day,current.sample_date,current.sample_interval,current.app,current.app_id,current.activity,current.project)
          IS DISTINCT FROM ROW(excluded.day,excluded.sample_date,excluded.sample_interval,excluded.app,excluded.app_id,excluded.activity,excluded.project)
          OR excluded.received_at>current.received_at
        RETURNING participant,id,day`,
        values,
      );
      const touched = new Map<string, { participant: string; day: string }>();
      const before = new Map(previous.rows.map((r) => [r.participant + "\0" + r.id, r.day]));
      for (const row of changed.rows)
        for (const day of [row.day, before.get(row.participant + "\0" + row.id)])
          if (day) touched.set(row.participant + "\0" + day, { participant: row.participant, day });
      if (touched.size) {
        const keys = [...touched.values()];
        const args = [keys.map((k) => k.participant), keys.map((k) => k.day)];
        await client.query(
          `INSERT INTO ${this.days} AS current (participant,day,revision,samples,first_sample,last_sample,first_edge,last_edge)
          SELECT participant,day,nextval('"${this.schema}".day_revision'),${DAY_AGGREGATES}
          FROM ${this.table} WHERE (participant,day) IN (SELECT * FROM unnest($1::text[],$2::text[]))
          GROUP BY participant,day ON CONFLICT (participant,day) DO UPDATE SET
          revision=excluded.revision,samples=excluded.samples,first_sample=excluded.first_sample,
          last_sample=excluded.last_sample,first_edge=excluded.first_edge,last_edge=excluded.last_edge`,
          args,
        );
        await client.query(
          `DELETE FROM ${this.days} d WHERE (participant,day) IN (SELECT * FROM unnest($1::text[],$2::text[]))
          AND NOT EXISTS (SELECT 1 FROM ${this.table} s WHERE s.participant=d.participant AND s.day=d.day)`,
          args,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async ping() {
    await this.pool.query("SELECT 1");
  }
  async sourceDays(participant: string) {
    const result = await this.pool.query<{
      day: string;
      revision: string;
      first: number;
      last: number;
      start: number;
      end: number;
    }>(
      `SELECT day,revision::text AS revision,first_sample AS first,last_sample AS last,first_edge AS start,last_edge AS "end"
      FROM ${this.days} WHERE participant=$1 ORDER BY day`,
      [participant],
    );
    return result.rows;
  }
  async readSummaries(participant: string, timeZone: string, days: string[]) {
    if (!days.length) return new Map<string, CachedSummary>();
    const result = await this.pool.query<CachedSummary>(
      `SELECT day,stamp,summary FROM ${this.summaries} WHERE participant=$1 AND time_zone=$2 AND day=ANY($3::text[])`,
      [participant, timeZone, days],
    );
    return new Map(result.rows.map((row) => [row.day, row]));
  }
  async writeSummaries(participant: string, timeZone: string, rows: CachedSummary[]) {
    if (!rows.length) return;
    await this.pool.query(
      `INSERT INTO ${this.summaries} (participant,time_zone,day,stamp,summary)
      SELECT $1,$2,day,stamp,summary FROM jsonb_to_recordset($3::jsonb) AS r(day text,stamp text,summary jsonb)
      ON CONFLICT (participant,time_zone,day) DO UPDATE SET stamp=excluded.stamp,summary=excluded.summary,computed_at=now()`,
      [participant, timeZone, JSON.stringify(rows)],
    );
  }
  async page(participant: string, cursor: string, limit: number) {
    const [page, first] = await Promise.all([
      this.pool.query<{ day: string }>(
        `SELECT day FROM ${this.days} WHERE participant=$1 AND day>$2 ORDER BY day LIMIT $3`,
        [participant, cursor, limit + 1],
      ),
      this.pool.query<{ start: number | null }>(
        `SELECT min(first_sample) AS start FROM ${this.days} WHERE participant=$1`,
        [participant],
      ),
    ]);
    return pageResult(
      page.rows.map((r) => r.day),
      limit,
      first.rows[0].start,
    );
  }
  async read(participant: string, from: string, to: string) {
    const result = await this.pool.query<Row>(
      `SELECT id,day,sample_date AS date,sample_interval AS interval,app,app_id AS "appID",activity,project,
      (EXTRACT(EPOCH FROM received_at)*1000)::float8 AS "receivedAt" FROM ${this.table} WHERE participant=$1 AND day BETWEEN $2 AND $3`,
      [participant, from, to],
    );
    return collect(result.rows);
  }
  async close() {
    await this.pool.end();
  }
}
export class ClickHouseAnalytics implements AnalyticsIndex {
  readonly key: string;
  private endpoint: URL;
  private table: string;
  constructor(
    url: string,
    private user = "default",
    private password = "",
    private database = "breadcrumb",
  ) {
    this.endpoint = new URL(url);
    if (
      !["http:", "https:"].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw Error("Use a ClickHouse HTTP URL and separate credentials");
    identifier(database);
    this.table = `\`${database}\`.samples`;
    this.key = fingerprint("clickhouse", this.endpoint.href + database);
  }
  private async query<T>(
    sql: string,
    params: Record<string, string | number> = {},
    data?: string,
  ): Promise<T[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set("query", sql);
    url.searchParams.set("wait_end_of_query", "1");
    url.searchParams.set("max_execution_time", "15");
    if (data !== undefined) {
      url.searchParams.set("async_insert", "1");
      url.searchParams.set("wait_for_async_insert", "1");
      url.searchParams.set("async_insert_busy_timeout_ms", "200");
      url.searchParams.set("date_time_input_format", "best_effort");
    }
    for (const [key, value] of Object.entries(params))
      url.searchParams.set("param_" + key, String(value));
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "X-ClickHouse-User": this.user,
          "X-ClickHouse-Key": this.password,
          "Content-Type": "text/plain",
        },
        body: data ?? "",
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw Error();
      const result = await response.text();
      return result.trim()
        ? result
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as T)
        : [];
    } catch {
      throw Error("ClickHouse analytics is unavailable");
    }
  }
  async migrate() {
    await this.query(`CREATE DATABASE IF NOT EXISTS \`${this.database}\``);
    await this.query(
      `CREATE TABLE IF NOT EXISTS \`${this.database}\`.agent_hours (participant String,source String,hour DateTime64(3,'UTC'),revision UInt64,snapshot String) ENGINE=ReplacingMergeTree(revision) PARTITION BY toYYYYMM(hour) ORDER BY(participant,source,hour)`,
    );
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      participant String,id String,day String,sample_date Float64,sample_interval Float64,
      app LowCardinality(String),app_id LowCardinality(String),activity LowCardinality(String),project String,
      received_at DateTime64(3,'UTC')
    ) ENGINE=ReplacingMergeTree PARTITION BY substring(day,1,7) ORDER BY (participant,day,id)`);
  }
  async writeAgents(participant: string, snapshots: AgentSnapshot[]) {
    if (!snapshots.length) return;
    await this.query(
      `INSERT INTO \`${this.database}\`.agent_hours FORMAT JSONEachRow`,
      {},
      snapshots
        .map((s) =>
          JSON.stringify({
            participant,
            source: s.source,
            hour: s.hour,
            revision: s.revision,
            snapshot: JSON.stringify(s),
          }),
        )
        .join("\n") + "\n",
    );
  }
  async readAgents(participant: string, from: string, to: string) {
    return (
      await this.query<{ snapshot: string }>(
        `SELECT snapshot FROM \`${this.database}\`.agent_hours FINAL WHERE participant={participant:String} AND hour BETWEEN {from:DateTime64(3,'UTC')} AND {to:DateTime64(3,'UTC')} FORMAT JSONEachRow`,
        {
          participant,
          from: from.replace("T", " ").replace("Z", ""),
          to: to.replace("T", " ").replace("Z", ""),
        },
      )
    ).map((r) => JSON.parse(r.snapshot) as AgentSnapshot);
  }
  async write(rows: IndexedSample[]) {
    if (!rows.length) return;
    const data =
      rows
        .map(({ participant, id, sample: s, receivedAt }) =>
          JSON.stringify({
            participant,
            id,
            day: partition(s),
            sample_date: s.date,
            sample_interval: s.interval,
            app: s.app ?? "",
            app_id: s.appID ?? "",
            activity: s.activity ?? "",
            project: s.project ?? "",
            received_at: receivedAt,
          }),
        )
        .join("\n") + "\n";
    await this.query(`INSERT INTO ${this.table} FORMAT JSONEachRow`, {}, data);
  }
  async page(participant: string, cursor: string, limit: number) {
    const [page, first] = await Promise.all([
      this.query<{ day: string }>(
        `SELECT DISTINCT day FROM ${this.table} FINAL WHERE participant={participant:String} AND day>{cursor:String} ORDER BY day LIMIT {limit:UInt32} FORMAT JSONEachRow`,
        { participant, cursor, limit: limit + 1 },
      ),
      this.query<{ start: number | null }>(
        `SELECT minOrNull(sample_date) AS start FROM ${this.table} FINAL WHERE participant={participant:String} FORMAT JSONEachRow`,
        { participant },
      ),
    ]);
    return pageResult(
      page.map((r) => r.day),
      limit,
      first[0].start,
    );
  }
  async read(participant: string, from: string, to: string) {
    const rows = await this.query<Row>(
      `SELECT id,day,sample_date AS date,sample_interval AS interval,app,app_id AS appID,activity,project,toUnixTimestamp64Milli(received_at) AS receivedAt
      FROM ${this.table} FINAL WHERE participant={participant:String} AND day BETWEEN {from:String} AND {to:String} FORMAT JSONEachRow`,
      { participant, from, to },
    );
    return collect(rows);
  }
  async close() {}
}
export function analyticsIndex(env: NodeJS.ProcessEnv = process.env): AnalyticsIndex | undefined {
  const backend = env.ANALYTICS_BACKEND || "r2";
  if (backend === "r2") return undefined;
  if (backend === "postgres") {
    const url = env.ANALYTICS_DATABASE_URL || env.DATABASE_URL;
    if (!url) throw Error("PostgreSQL analytics requires a database URL");
    return new PostgresAnalytics(url);
  }
  if (backend === "clickhouse") {
    if (!env.CLICKHOUSE_URL) throw Error("ClickHouse analytics requires CLICKHOUSE_URL");
    return new ClickHouseAnalytics(
      env.CLICKHOUSE_URL,
      env.CLICKHOUSE_USER,
      env.CLICKHOUSE_PASSWORD,
      env.CLICKHOUSE_DATABASE,
    );
  }
  throw Error("Unsupported analytics backend");
}
