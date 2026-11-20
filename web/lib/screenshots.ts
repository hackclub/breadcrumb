import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { Store } from "./store";
import { APIProblem } from "./api-http";
const uuid = z.uuid();
const hidden = () =>
  new APIProblem(
    404,
    "screenshot_not_found",
    "Screenshot not found or no longer shared.",
    "Check the link or ask its owner to share it again.",
  );
export const sharesSchema = `CREATE TABLE IF NOT EXISTS breadcrumb_integrations.shares (
  id text PRIMARY KEY, secret_hash text NOT NULL, owner_id text NOT NULL REFERENCES breadcrumb_auth."user"(id) ON DELETE CASCADE,
  participant text NOT NULL, capture_id text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
); CREATE INDEX IF NOT EXISTS shares_owner ON breadcrumb_integrations.shares(owner_id,created_at DESC);`;
export class Screenshots {
  constructor(
    private store: Store,
    private pool: Pool,
  ) {}
  async capture(participant: string, id: string) {
    if (!uuid.safeParse(id).success) throw hidden();
    const raw = await this.store.get(`captures/${participant}/${id.toLowerCase()}.json`);
    if (!raw) throw hidden();
    const value = JSON.parse(Buffer.from(raw).toString());
    if (value.participant !== participant) throw hidden();
    return value as {
      participant: string;
      upload: {
        record: { id: string; date: number };
        payload: { jpeg?: string; jpegRef?: string };
      };
    };
  }
  async image(participant: string, id: string) {
    const entry = await this.capture(participant, id);
    const payload = entry.upload.payload;
    const data = payload.jpeg
      ? Buffer.from(payload.jpeg, "base64")
      : /^[a-f0-9]{64}$/.test(payload.jpegRef ?? "")
        ? await this.store.get(`images/${participant}/${payload.jpegRef}.jpg`)
        : null;
    if (!data) throw hidden();
    return new Response(Buffer.from(data), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  async list(participant: string, cursor = "") {
    if (cursor.length > 2048)
      throw new APIProblem(
        400,
        "invalid_cursor",
        "Invalid cursor.",
        "Use nextCursor from the previous response.",
      );
    const page = await this.store.list(`captures/${participant}/`, cursor, 20);
    const entries = [];
    for (let i = 0; i < page.keys.length; i += 5)
      entries.push(
        ...(await Promise.all(
          page.keys.slice(i, i + 5).map(async (key) => {
            const id = key.split("/").at(-1)!.slice(0, -5),
              entry = await this.capture(participant, id);
            return {
              id: entry.upload.record.id,
              date: new Date((entry.upload.record.date + 978307200) * 1000).toISOString(),
              hasScreenshot: Boolean(entry.upload.payload.jpeg || entry.upload.payload.jpegRef),
            };
          }),
        )),
      );
    return { entries, nextCursor: page.cursor };
  }
  async share(owner: string, participant: string, input: unknown) {
    const value = z
      .object({ captureId: uuid, expiresInHours: z.number().int().min(1).max(168).default(24) })
      .strict()
      .safeParse(input);
    if (!value.success)
      throw new APIProblem(
        400,
        "invalid_share",
        "Choose a capture and an expiry between 1 and 168 hours.",
        "Send captureId and optional expiresInHours.",
      );
    const image = await this.capture(participant, value.data.captureId);
    if (!image.upload.payload.jpeg && !image.upload.payload.jpegRef) throw hidden();
    const id = randomBytes(16).toString("hex"),
      secret = randomBytes(32).toString("base64url"),
      hash = createHash("sha256").update(secret).digest("hex");
    // Bound active links per account; serialize creation using the existing owner row.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('SELECT id FROM breadcrumb_auth."user" WHERE id=$1 FOR UPDATE', [owner]);
      const count = await client.query(
        "SELECT count(*)::int AS n FROM breadcrumb_integrations.shares WHERE owner_id=$1 AND expires_at>now()",
        [owner],
      );
      if (count.rows[0].n >= 100)
        throw new APIProblem(
          429,
          "too_many_shares",
          "You have 100 active screenshot links.",
          "Revoke an existing link before creating another.",
        );
      const result = await client.query(
        "INSERT INTO breadcrumb_integrations.shares(id,secret_hash,owner_id,participant,capture_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 hour') RETURNING expires_at",
        [id, hash, owner, participant, value.data.captureId, value.data.expiresInHours],
      );
      await client.query("COMMIT");
      return {
        id,
        token: `${id}.${secret}`,
        expiresAt: new Date(result.rows[0].expires_at).toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async resolve(token: string) {
    if (!/^[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) throw hidden();
    const [id, secret] = token.split(".");
    const { rows } = await this.pool.query(
      "SELECT participant,capture_id FROM breadcrumb_integrations.shares WHERE id=$1 AND secret_hash=$2 AND expires_at>now()",
      [id, createHash("sha256").update(secret).digest("hex")],
    );
    if (!rows[0]) throw hidden();
    return rows[0] as { participant: string; capture_id: string };
  }
  async shared(token: string) {
    const row = await this.resolve(token);
    return this.image(row.participant, row.capture_id);
  }
  async shares(owner: string) {
    const { rows } = await this.pool.query(
      'SELECT id,capture_id AS "captureId",expires_at AS "expiresAt" FROM breadcrumb_integrations.shares WHERE owner_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 100',
      [owner],
    );
    return { entries: rows };
  }
  async revoke(owner: string, id: string) {
    await this.pool.query(
      "DELETE FROM breadcrumb_integrations.shares WHERE owner_id=$1 AND id=$2",
      [owner, id],
    );
  }
}
