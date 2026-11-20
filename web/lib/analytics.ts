import { createHash } from "node:crypto";
import { Pool } from "pg";
import { REFERENCE, type Sample } from "./insights";

export type SampleDay = { samples: Record<string, Sample>; updatedAt: string };
export type IndexedSample = { participant: string; id: string; sample: Sample; receivedAt: string };
export interface AnalyticsIndex {
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
    this.pool = new Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  async migrate() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      participant text NOT NULL, id text NOT NULL, day text NOT NULL,
      sample_date double precision NOT NULL, sample_interval double precision NOT NULL,
      app text NOT NULL, app_id text NOT NULL, activity text NOT NULL, project text NOT NULL,
      received_at timestamptz NOT NULL, PRIMARY KEY (participant,id)
    )`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS samples_by_day ON ${this.table} (participant,day,sample_date)`,
    );
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
    await this.pool.query(
      `INSERT INTO ${this.table} AS current (participant,id,day,sample_date,sample_interval,app,app_id,activity,project,received_at)
      VALUES ${placeholders.join(",")} ON CONFLICT (participant,id) DO UPDATE SET
      day=excluded.day,sample_date=excluded.sample_date,sample_interval=excluded.sample_interval,
      app=excluded.app,app_id=excluded.app_id,activity=excluded.activity,project=excluded.project,
      received_at=GREATEST(current.received_at,excluded.received_at)`,
      values,
    );
  }
  async page(participant: string, cursor: string, limit: number) {
    const [page, first] = await Promise.all([
      this.pool.query<{ day: string }>(
        `SELECT DISTINCT day FROM ${this.table} WHERE participant=$1 AND day>$2 ORDER BY day LIMIT $3`,
        [participant, cursor, limit + 1],
      ),
      this.pool.query<{ start: number | null }>(
        `SELECT min(sample_date) AS start FROM ${this.table} WHERE participant=$1`,
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
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      participant String,id String,day String,sample_date Float64,sample_interval Float64,
      app LowCardinality(String),app_id LowCardinality(String),activity LowCardinality(String),project String,
      received_at DateTime64(3,'UTC')
    ) ENGINE=ReplacingMergeTree PARTITION BY substring(day,1,7) ORDER BY (participant,day,id)`);
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
