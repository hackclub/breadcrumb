import { Pool } from "pg";
import { z } from "zod";
import { appSeed, mergeApps } from "./apps";
import { summarize, type Breakdown, type InsightDay } from "./insights";
import { syncedSummary } from "./sync";
import type { Store } from "./store";
import type { AnalyticsIndex, SampleDay } from "./analytics";

export type LeaderboardRange = "7" | "30" | "all";
export type LeaderboardPreferences = {
  enabled: boolean;
  shareApps: boolean;
  profileReady: boolean;
};
export type LeaderboardEntry = {
  rank: number;
  username: string;
  displayName: string;
  profileURL: string;
  avatarURL?: string;
  seconds: number;
  apps?: Breakdown;
};
export type Leaderboard = {
  range: LeaderboardRange;
  entries: LeaderboardEntry[];
  nextCursor: string;
  updatedAt: string | null;
};
export class LeaderboardError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const preferencesPatch = z
  .object({ enabled: z.boolean().optional(), shareApps: z.boolean().optional() })
  .strict();
const cursorSchema = z
  .object({
    range: z.enum(["7", "30", "all"]),
    day: z.iso.date(),
    seconds: z.number().finite().nonnegative(),
    username: z.string().regex(/^[a-z0-9][a-z0-9_]{2,23}$/),
  })
  .strict();
const dayOffset = (day: string, offset: number) =>
  new Date(Date.parse(day + "T12:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
const daySchema = z.object({
  day: z.iso.date(),
  seconds: z.number().finite().min(0).max(86400),
  captures: z.number().int().nonnegative(),
  lastSynced: z.iso.datetime(),
  apps: z
    .array(
      z.object({
        name: z.string().max(200),
        id: z.string().max(200).optional(),
        seconds: z.number().finite().min(0).max(86400),
      }),
    )
    .max(10000),
});
type PublicRow = {
  rank: string;
  username: string;
  displayName: string;
  avatarMode: string;
  profileUpdatedAt: Date;
  seconds: number;
  shareApps: boolean;
  apps: Breakdown | null;
  updatedAt: Date;
};
export class PostgresLeaderboards {
  constructor(
    private pool: Pool,
    private now: () => Date = () => new Date(),
  ) {}
  async preferences(owner: string): Promise<LeaderboardPreferences> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(l.enabled,true) AS enabled, COALESCE(l.share_app_usage,false) AS "shareApps",
       COALESCE(p.visibility='public',false) AS "profileReady"
       FROM breadcrumb_auth."user" u
       LEFT JOIN breadcrumb_profiles.profiles p ON p.owner_id=u.id
       LEFT JOIN breadcrumb_leaderboards.preferences l ON l.owner_id=u.id WHERE u.id=$1`,
      [owner],
    );
    return rows[0] ?? { enabled: true, shareApps: false, profileReady: false };
  }
  async savePreferences(
    owner: string,
    participant: string,
    value: unknown,
  ): Promise<LeaderboardPreferences> {
    const parsed = preferencesPatch.safeParse(value);
    if (!parsed.success || !/^[a-f0-9]{64}$/.test(participant))
      throw new LeaderboardError(400, "Choose valid leaderboard sharing settings.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const profile = await client.query(
        `SELECT p.visibility,encode(sha256(convert_to(lower(btrim(u.email)),'UTF8')),'hex') AS participant
        FROM breadcrumb_auth."user" u LEFT JOIN breadcrumb_profiles.profiles p ON p.owner_id=u.id
        WHERE u.id=$1 FOR UPDATE OF u`,
        [owner],
      );
      if (profile.rows[0]?.participant !== participant)
        throw new LeaderboardError(400, "This account cannot update those leaderboard settings.");
      if (parsed.data.enabled && profile.rows[0]?.visibility !== "public")
        throw new LeaderboardError(409, "Reserve a public profile before joining the leaderboard.");
      await client.query(
        `INSERT INTO breadcrumb_leaderboards.preferences AS current (owner_id,participant,enabled,share_app_usage)
        VALUES ($1,$2,COALESCE($3,true),COALESCE($4,false)) ON CONFLICT (owner_id) DO UPDATE SET
        enabled=COALESCE($3,current.enabled),share_app_usage=COALESCE($4,current.share_app_usage),updated_at=now()`,
        [owner, participant, parsed.data.enabled, parsed.data.shareApps],
      );
      await client.query(
        `DELETE FROM breadcrumb_leaderboards.days d USING breadcrumb_leaderboards.preferences p
        WHERE p.owner_id=$1 AND d.participant=p.participant AND NOT p.enabled`,
        [owner],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.preferences(owner);
  }
  async ensureParticipant(participant: string, owner?: string) {
    if (!/^[a-f0-9]{64}$/.test(participant))
      throw new LeaderboardError(400, "Invalid participant.");
    // The stored mapping makes future ingests indexed lookups. First-time lookup
    // binds the supplied participant to Better Auth's verified account identity.
    await this.pool.query(
      `INSERT INTO breadcrumb_leaderboards.preferences (owner_id,participant,enabled)
      SELECT u.id,$1,true FROM breadcrumb_auth."user" u
      WHERE ($2::text IS NULL OR u.id=$2) AND
        encode(sha256(convert_to(lower(btrim(u.email)),'UTF8')),'hex')=$1
        AND NOT EXISTS(SELECT 1 FROM breadcrumb_leaderboards.preferences p WHERE p.participant=$1)
      ON CONFLICT DO NOTHING`,
      [participant, owner ?? null],
    );
  }
  async write(
    participant: string,
    input: Pick<InsightDay, "day" | "seconds" | "captures" | "apps" | "lastSynced">[],
  ) {
    if (!/^[a-f0-9]{64}$/.test(participant) || input.length > 62)
      throw new LeaderboardError(400, "Invalid leaderboard index batch.");
    const days = input.map((day) => daySchema.parse(day));
    if (!days.length) return;
    // Lock preferences before daily rows, as savePreferences does. Disabling cannot
    // race with an in-flight ingest and repopulate a withdrawn user's index.
    await this.ensureParticipant(participant);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const preference = await client.query(
        `SELECT 1 FROM breadcrumb_leaderboards.preferences WHERE participant=$1 AND enabled FOR UPDATE`,
        [participant],
      );
      if (preference.rowCount)
        for (const day of days) {
          const apps = mergeApps(day.apps, appSeed).slice(0, 100);
          await client.query(
            `INSERT INTO breadcrumb_leaderboards.days AS current (participant,day,seconds,captures,apps,source_updated_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (participant,day) DO UPDATE SET
          seconds=excluded.seconds,captures=excluded.captures,apps=excluded.apps,source_updated_at=excluded.source_updated_at
          WHERE excluded.source_updated_at > current.source_updated_at OR
            (excluded.source_updated_at=current.source_updated_at AND
              (excluded.captures>current.captures OR (excluded.captures=current.captures AND excluded.seconds>=current.seconds)))`,
            [participant, day.day, day.seconds, day.captures, JSON.stringify(apps), day.lastSynced],
          );
        }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async refresh(participant: string, store: Store, cursor = "", index?: AnalyticsIndex) {
    const page = await syncedSummary(store, participant, cursor, "UTC", index);
    await this.write(participant, page.days);
    return { done: !page.nextCursor, nextCursor: page.nextCursor, daysIndexed: page.days.length };
  }
  async refreshDays(participant: string, store: Store, days: string[], index?: AnalyticsIndex) {
    if (days.length > 3 || days.some((day) => !z.iso.date().safeParse(day).success))
      throw new LeaderboardError(400, "Invalid leaderboard days.");
    if (!days.length) return;
    const ordered = [...new Set(days)].sort();
    const from = dayOffset(ordered[0], -1),
      to = dayOffset(ordered.at(-1)!, 1);
    let source: Map<string, SampleDay>;
    let historyStart: number | undefined;
    if (index) {
      const [nearby, first] = await Promise.all([
        index.read(participant, from, to),
        index.page(participant, "", 1),
      ]);
      source = nearby;
      historyStart = first.historyStart ?? undefined;
    } else {
      const wanted = [
        ...new Set(ordered.flatMap((day) => [-1, 0, 1].map((offset) => dayOffset(day, offset)))),
      ];
      source = new Map();
      await Promise.all(
        wanted.map(async (day) => {
          const raw = await store.get(`sync/days/${participant}/${day}.json`);
          if (raw) source.set(day, JSON.parse(Buffer.from(raw).toString()));
        }),
      );
      const firstKey = (await store.list(`sync/days/${participant}/`, "", 1)).keys[0];
      if (firstKey) {
        const firstDay = firstKey.split("/").at(-1)!.slice(0, -5);
        const loaded = source.get(firstDay);
        const raw = loaded ? null : await store.get(firstKey);
        const first: SampleDay | undefined =
          loaded ?? (raw ? JSON.parse(Buffer.from(raw).toString()) : undefined);
        const dates = Object.values(first?.samples ?? {})
          .map((sample) => sample.date)
          .filter(Number.isFinite);
        if (dates.length) historyStart = Math.min(...dates);
      }
    }
    const values = ordered.flatMap((day) => {
      const nearby = [-1, 0, 1].flatMap((offset) => source.get(dayOffset(day, offset)) ?? []);
      if (!nearby.length) return [];
      const samples = nearby.flatMap((value) =>
        Object.entries(value.samples)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, sample]) => sample),
      );
      const value = summarize(samples, day, undefined, "UTC", historyStart);
      return [
        {
          day,
          ...value,
          lastSynced: nearby
            .map((entry) => entry.updatedAt)
            .sort()
            .at(-1)!,
        },
      ];
    });
    await this.write(participant, values);
  }
  async leaderboard(options: {
    range?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Leaderboard> {
    const range = options.range ?? "7";
    if (
      !["7", "30", "all"].includes(range) ||
      (options.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50))
    )
      throw new LeaderboardError(
        400,
        "Choose a supported leaderboard range and a limit from 1 to 50.",
      );
    const limit = options.limit ?? 20;
    const today = this.now().toISOString().slice(0, 10);
    const since = range === "all" ? "0001-01-01" : dayOffset(today, 1 - Number(range));
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (options.cursor) {
      try {
        if (options.cursor.length > 1000) throw Error();
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(options.cursor, "base64url").toString()),
        );
        if (cursor.range !== range || cursor.day !== today) throw Error();
      } catch {
        throw new LeaderboardError(
          400,
          "This leaderboard cursor has expired or is invalid. Start from the first page.",
        );
      }
    }
    const totals =
      range === "all"
        ? `SELECT participant,total_seconds AS seconds,updated_at FROM breadcrumb_leaderboards.preferences WHERE enabled AND total_seconds>0`
        : `SELECT d.participant,SUM(d.seconds) AS seconds,MAX(d.source_updated_at) AS updated_at FROM breadcrumb_leaderboards.days d JOIN breadcrumb_leaderboards.preferences p USING(participant) WHERE p.enabled AND d.day >= $1::date AND d.day <= $2::date GROUP BY d.participant HAVING SUM(d.seconds)>0`;
    // LIMIT is applied before app aggregation; no request scans capture contents.
    const query = `WITH totals AS (${totals}), ranked AS (
      SELECT ROW_NUMBER() OVER (ORDER BY t.seconds DESC,p.username) AS rank,
        p.username,p.display_name AS "displayName",p.avatar_mode AS "avatarMode",p.updated_at AS "profileUpdatedAt",
        t.participant,t.seconds,t.updated_at AS "updatedAt",l.share_app_usage AS "shareApps"
      FROM totals t JOIN breadcrumb_leaderboards.preferences l USING(participant)
      JOIN breadcrumb_profiles.profiles p ON p.owner_id=l.owner_id WHERE l.enabled AND p.visibility='public'
    ), page AS (SELECT * FROM ranked WHERE ($3::float8 IS NULL OR seconds<$3 OR (seconds=$3 AND username>$4)) ORDER BY seconds DESC,username LIMIT $5)
    SELECT page.*,CASE WHEN page."shareApps" THEN (
      SELECT jsonb_agg(jsonb_build_object('name',name,'id',id,'seconds',seconds) ORDER BY seconds DESC,name) FROM (
        SELECT app->>'name' AS name,app->>'id' AS id,SUM((app->>'seconds')::float8) AS seconds
        FROM breadcrumb_leaderboards.days d CROSS JOIN LATERAL jsonb_array_elements(d.apps) app
        WHERE d.participant=page.participant AND d.day >= $1::date AND d.day <= $2::date
        GROUP BY app->>'name',app->>'id' ORDER BY seconds DESC,name LIMIT 5
      ) top_apps
    ) ELSE NULL END AS apps FROM page ORDER BY seconds DESC,username`;
    const { rows } = await this.pool.query<PublicRow>(query, [
      since,
      today,
      cursor?.seconds ?? null,
      cursor?.username ?? "",
      limit + 1,
    ]);
    const shown = rows.slice(0, limit);
    return {
      range: range as LeaderboardRange,
      entries: shown.map((row) => ({
        rank: Number(row.rank),
        username: row.username,
        displayName: row.displayName,
        profileURL: `/@${row.username}`,
        seconds: row.seconds,
        ...(row.avatarMode !== "none"
          ? {
              avatarURL: `/api/profiles/${row.username}/avatar?v=${new Date(row.profileUpdatedAt).getTime()}`,
            }
          : {}),
        ...(row.shareApps ? { apps: row.apps ?? [] } : {}),
      })),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                range,
                day: today,
                seconds: shown.at(-1)!.seconds,
                username: shown.at(-1)!.username,
              }),
            ).toString("base64url")
          : "",
      updatedAt: shown.length
        ? new Date(Math.max(...shown.map((row) => new Date(row.updatedAt).getTime()))).toISOString()
        : null,
    };
  }
}
let instance: PostgresLeaderboards | undefined;
export function getLeaderboards() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
  return (instance ??= new PostgresLeaderboards(
    new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    }),
  ));
}
