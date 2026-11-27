import type { Pool, PoolClient } from "pg";
import { z } from "zod";

/** One row per desktop OAuth client, naming the device it runs on. */
export const devicesSchema = `CREATE SCHEMA IF NOT EXISTS breadcrumb_integrations;
CREATE TABLE IF NOT EXISTS breadcrumb_integrations.desktop_devices (
  client_id text PRIMARY KEY, user_id text NOT NULL, device_id text NOT NULL,
  name text NOT NULL, platform text NOT NULL, app_version text NOT NULL DEFAULT '',
  registered_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS desktop_devices_by_device ON breadcrumb_integrations.desktop_devices (user_id, device_id);
`;

const clean = (value: string) =>
  value
    .normalize("NFC")
    .replace(/[\p{C}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
export const deviceInput = z
  .object({
    deviceId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    name: z.string().max(200).transform(clean).pipe(z.string().min(1).max(80)),
    platform: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    version: z
      .string()
      .regex(/^[0-9A-Za-z.+-]{0,32}$/)
      .default(""),
    /** Earlier clients this device used, such as a separate token-usage connection. */
    replaces: z.array(z.string().min(1).max(256)).max(5).default([]),
  })
  .strict();
export type DeviceInput = z.input<typeof deviceInput>;
export type DeviceDetails = {
  name: string;
  platform: string;
  version: string;
};
const SYNC_SCOPES = ["captures:sync", "agents:sync"];

async function transaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Records which device a desktop client runs on and disconnects that device's older sync
 * connections. Only the same user's connections that grant a sync scope are ever removed, so
 * a device cannot disconnect API or MCP apps.
 */
export async function registerDevice(
  db: Pool,
  owner: { userId: string; clientId: string },
  raw: unknown,
) {
  const input = deviceInput.parse(raw);
  return transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "breadcrumb-device:" + owner.userId,
    ]);
    const saved = await client.query(
      `INSERT INTO breadcrumb_integrations.desktop_devices (client_id,user_id,device_id,name,platform,app_version)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (client_id) DO UPDATE SET
      device_id=excluded.device_id,name=excluded.name,platform=excluded.platform,app_version=excluded.app_version,updated_at=now()
      WHERE desktop_devices.user_id=excluded.user_id RETURNING client_id`,
      [owner.clientId, owner.userId, input.deviceId, input.name, input.platform, input.version],
    );
    if (!saved.rowCount) throw Error("This client belongs to another account");
    const previous = await client.query<{ client_id: string }>(
      `SELECT client_id FROM breadcrumb_integrations.desktop_devices
      WHERE user_id=$1 AND device_id=$2 AND client_id<>$3`,
      [owner.userId, input.deviceId, owner.clientId],
    );
    const candidates = [
      ...new Set([
        ...previous.rows.map((row) => row.client_id),
        ...input.replaces.filter((id) => id !== owner.clientId),
      ]),
    ];
    if (!candidates.length) return { replaced: 0 };
    const removed = await client.query<{ clientId: string }>(
      `DELETE FROM breadcrumb_auth."oauthConsent" WHERE "userId"=$1 AND "clientId"=ANY($2::text[])
      AND scopes ?| $3::text[] RETURNING "clientId"`,
      [owner.userId, candidates, SYNC_SCOPES],
    );
    const replaced = removed.rows.map((row) => row.clientId);
    if (replaced.length) {
      await client.query(
        `UPDATE breadcrumb_auth."oauthRefreshToken" SET revoked=now()
        WHERE "userId"=$1 AND "clientId"=ANY($2::text[]) AND revoked IS NULL`,
        [owner.userId, replaced],
      );
    }
    await client.query(
      `DELETE FROM breadcrumb_integrations.desktop_devices WHERE user_id=$1 AND client_id=ANY($2::text[])`,
      [owner.userId, candidates],
    );
    return { replaced: replaced.length };
  });
}

/** Device names and the last time each client renewed access. */
export async function connectionDetails(
  db: Pick<Pool, "query">,
  userId: string,
  clients: string[],
) {
  const details = new Map<string, { device: DeviceDetails | null; lastUsed: string | null }>();
  if (!clients.length) return details;
  const [devices, used] = await Promise.all([
    db.query<{ client_id: string; name: string; platform: string; app_version: string }>(
      `SELECT client_id,name,platform,app_version FROM breadcrumb_integrations.desktop_devices
      WHERE user_id=$1 AND client_id=ANY($2::text[])`,
      [userId, clients],
    ),
    // Desktop access tokens last five minutes, and each renewal issues a new refresh token.
    db.query<{ clientId: string; lastUsed: Date }>(
      `SELECT "clientId",max("createdAt") AS "lastUsed" FROM breadcrumb_auth."oauthRefreshToken"
      WHERE "userId"=$1 AND "clientId"=ANY($2::text[]) GROUP BY "clientId"`,
      [userId, clients],
    ),
  ]);
  for (const client of clients) details.set(client, { device: null, lastUsed: null });
  for (const row of devices.rows)
    details.get(row.client_id)!.device = {
      name: row.name,
      platform: row.platform,
      version: row.app_version,
    };
  for (const row of used.rows)
    details.get(row.clientId)!.lastUsed = new Date(row.lastUsed).toISOString();
  return details;
}
