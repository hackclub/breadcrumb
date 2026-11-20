import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { analyticsIndex } from "../lib/analytics";
import { PostgresLeaderboards } from "../lib/leaderboards";
import { R2Store } from "../lib/store";
const { values } = parseArgs({
  options: { cursor: { type: "string" }, pages: { type: "string", default: "10" } },
});
const pages = Number(values.pages);
if (!Number.isInteger(pages) || pages < 1 || pages > 100)
  throw Error("Choose --pages from 1 to 100");
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
const cursorSchema = z
  .object({ owner: z.string().max(200), dayCursor: z.string().max(2000), done: z.boolean() })
  .strict();
let state = { owner: "", dayCursor: "", done: true };
if (values.cursor) {
  try {
    state = cursorSchema.parse(JSON.parse(Buffer.from(values.cursor, "base64url").toString()));
  } catch {
    throw Error("Invalid backfill cursor");
  }
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5000,
});
const repo = new PostgresLeaderboards(pool);
const index = analyticsIndex();
const store = new R2Store();
let indexed = 0;
try {
  for (let page = 0; page < pages; page++) {
    const { rows } = await pool.query<{ id: string; email: string }>(
      `SELECT u.id,u.email FROM breadcrumb_auth."user" u
      JOIN breadcrumb_profiles.profiles p ON p.owner_id=u.id
      LEFT JOIN breadcrumb_leaderboards.preferences l ON l.owner_id=u.id
      WHERE p.visibility='public' AND COALESCE(l.enabled,true) AND (u.id>$1 OR (u.id=$1 AND NOT $2))
      ORDER BY u.id LIMIT 1`,
      [state.owner, state.done],
    );
    const user = rows[0];
    if (!user) {
      console.log(JSON.stringify({ indexed, done: true, nextCursor: "" }));
      break;
    }
    const participant = createHash("sha256").update(user.email.trim().toLowerCase()).digest("hex");
    const result = await repo.refresh(
      participant,
      store,
      state.owner === user.id ? state.dayCursor : "",
      index ?? undefined,
    );
    indexed += result.daysIndexed;
    state = { owner: user.id, dayCursor: result.nextCursor, done: result.done };
    if (page === pages - 1)
      console.log(
        JSON.stringify({
          indexed,
          done: false,
          nextCursor: Buffer.from(JSON.stringify(state)).toString("base64url"),
        }),
      );
  }
} finally {
  await index?.close();
  await pool.end();
}
