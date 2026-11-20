import type { Pool } from "pg";
import { platformDB } from "./platform-db";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getAuth, allowedEmail } from "./auth";
import { appCatalog } from "./app-catalog";
import type { AppEntry } from "./apps";

export type AvatarMode = "none" | "gravatar" | "upload";
export type Profile = {
  avatarMode: AvatarMode;
  avatarURL: string | null;
  githubUrl: string;
  websiteUrl: string;
  username: string;
  displayName: string;
  bio: string;
  visibility: "public" | "private";
  shareApps: boolean;
  apps: string[];
  createdAt: string;
  updatedAt: string;
};
export type PublicProfile = Pick<
  Profile,
  "username" | "displayName" | "bio" | "githubUrl" | "websiteUrl"
> & {
  avatarURL?: string;
  apps?: AppEntry[];
};
type Patch = Partial<
  Pick<
    Profile,
    | "username"
    | "displayName"
    | "bio"
    | "visibility"
    | "shareApps"
    | "apps"
    | "githubUrl"
    | "websiteUrl"
  >
>;
type AvatarPatch = { avatarMode?: "none" | "gravatar" };
type Session = { user: { id: string; email: string; emailVerified: boolean } } | null;
export class ProfileError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const reserved = new Set([
  "admin",
  "administrator",
  "api",
  "app",
  "apps",
  "auth",
  "breadcrumb",
  "dashboard",
  "help",
  "login",
  "logout",
  "signin",
  "signup",
  "support",
  "settings",
  "profile",
  "profiles",
  "account",
  "accounts",
  "security",
  "privacy",
  "terms",
  "system",
  "root",
  "status",
  "about",
  "null",
  "undefined",
  "www",
  "new",
  "edit",
  "official",
  "moderator",
  "staff",
]);
export function profileUsername(value: string) {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_]{2,23}$/.test(name) || reserved.has(name))
    throw new ProfileError(
      400,
      "Choose 3–24 letters, numbers or underscores, starting with a letter or number. This name must not be reserved.",
    );
  return name;
}
const schema = z
  .object({
    username: z.string().max(100).optional(),
    avatarMode: z.enum(["none", "gravatar"]).optional(),
    githubUrl: z.string().trim().max(2048).optional(),
    websiteUrl: z.string().trim().max(2048).optional(),
    displayName: z.string().trim().max(60).optional(),
    bio: z.string().trim().max(280).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    shareApps: z.boolean().optional(),
    apps: z.array(z.string().max(64)).max(30).optional(),
  })
  .strict();
export function profileLink(value: string, github = false) {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProfileError(400, "Enter a valid HTTPS profile link.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new ProfileError(400, "Profile links must use HTTPS without embedded credentials.");
  if (github) {
    if (
      url.hostname !== "github.com" ||
      url.port ||
      url.search ||
      url.hash ||
      !/^\/[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}\/?$/i.test(url.pathname)
    )
      throw new ProfileError(
        400,
        "Use your GitHub profile URL, such as https://github.com/your-name.",
      );
    return "https://github.com/" + url.pathname.split("/")[1];
  }
  return url.href;
}
export function profilePatch(value: unknown, apps: AppEntry[]): Patch & AvatarPatch {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ProfileError(
      400,
      "Check your profile fields. Names allow 60 characters, bios 280, and app lists 30 entries.",
    );
  const patch = parsed.data;
  if (patch.githubUrl !== undefined) patch.githubUrl = profileLink(patch.githubUrl, true);
  if (patch.websiteUrl !== undefined) patch.websiteUrl = profileLink(patch.websiteUrl);
  if (patch.username !== undefined) patch.username = profileUsername(patch.username);
  if (patch.apps) {
    const allowed = new Set(apps.map((app) => app.id));
    if (patch.apps.some((id) => !allowed.has(id)))
      throw new ProfileError(400, "Choose apps from the app catalog.");
    patch.apps = [...new Set(patch.apps)];
  }
  return patch;
}
export function publicProfile(profile: Profile | null, apps: AppEntry[]): PublicProfile | null {
  if (!profile || profile.visibility !== "public") return null;
  return {
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio,
    githubUrl: profile.githubUrl,
    websiteUrl: profile.websiteUrl,
    ...(profile.avatarMode !== "none"
      ? { avatarURL: `/api/profiles/${profile.username}/avatar?v=${Date.parse(profile.updatedAt)}` }
      : {}),
    ...(profile.shareApps ? { apps: apps.filter((app) => profile.apps.includes(app.id)) } : {}),
  };
}
export interface ProfileRepository {
  get(owner: string): Promise<Profile | null>;
  find(username: string): Promise<Profile | null>;
  available(username: string): Promise<boolean>;
  save(owner: string, patch: Patch & AvatarPatch, gravatarHash?: string): Promise<Profile>;
  limit(owner: string): Promise<void>;
}
const columns = `username, display_name AS "displayName", bio, visibility, share_apps AS "shareApps", apps,
  avatar_mode AS "avatarMode", github_url AS "githubUrl", website_url AS "websiteUrl",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
function profile(row: Profile | undefined) {
  if (!row) return null;
  return {
    ...row,
    avatarURL:
      row.avatarMode !== "none" ? `/api/profile/avatar?v=${Date.parse(row.updatedAt)}` : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
export class PostgresProfiles implements ProfileRepository {
  constructor(private pool: Pool) {}
  async get(owner: string) {
    const result = await this.pool.query<Profile>(
      `SELECT ${columns} FROM breadcrumb_profiles.profiles WHERE owner_id=$1`,
      [owner],
    );
    return profile(result.rows[0]);
  }
  async find(username: string) {
    const result = await this.pool.query<Profile>(
      `SELECT ${columns} FROM breadcrumb_profiles.profiles WHERE username=$1 AND visibility='public'`,
      [username],
    );
    return profile(result.rows[0]);
  }
  async available(username: string) {
    const result = await this.pool.query(
      "SELECT 1 FROM breadcrumb_profiles.profiles WHERE username=$1",
      [username],
    );
    return result.rows.length === 0;
  }
  async save(owner: string, patch: Patch & AvatarPatch, gravatarHash?: string) {
    const current = await this.get(owner);
    const username = patch.username ?? current?.username;
    if (!username) throw new ProfileError(400, "Choose a username to reserve your profile.");
    if (current && current.username !== username)
      throw new ProfileError(409, "Your username is already reserved and cannot be changed.");
    try {
      // Both unique constraints and immutable reservations are enforced by the same
      // atomic write. Partial edits do not restore stale privacy settings.
      const result = await this.pool.query<Profile>(
        `
        INSERT INTO breadcrumb_profiles.profiles AS p
          (owner_id,username,display_name,bio,visibility,share_apps,apps,github_url,website_url,avatar_mode,avatar_hash)
        VALUES ($1,$2,COALESCE($3,''),COALESCE($4,''),COALESCE($5,'public'),COALESCE($6,false),COALESCE($7::text[],'{}'::text[]),COALESCE($8,''),COALESCE($9,''),COALESCE($10,'none'),$11)
        ON CONFLICT (owner_id) DO UPDATE SET
          display_name=COALESCE($3,p.display_name), bio=COALESCE($4,p.bio),
          visibility=COALESCE($5,p.visibility), share_apps=COALESCE($6,p.share_apps),
          apps=COALESCE($7::text[],p.apps), github_url=COALESCE($8,p.github_url), website_url=COALESCE($9,p.website_url),
          avatar_mode=COALESCE($10,p.avatar_mode),
          avatar_key=CASE WHEN $10::text IS NULL THEN p.avatar_key ELSE NULL END,
          avatar_hash=CASE WHEN $10::text IS NULL THEN p.avatar_hash ELSE $11 END,
          updated_at=now()
        WHERE p.username=excluded.username RETURNING ${columns}`,
        [
          owner,
          username,
          patch.displayName,
          patch.bio,
          patch.visibility,
          patch.shareApps,
          patch.apps,
          patch.githubUrl,
          patch.websiteUrl,
          patch.avatarMode,
          gravatarHash,
        ],
      );
      const saved = profile(result.rows[0]);
      if (!saved)
        throw new ProfileError(409, "Your username is already reserved and cannot be changed.");
      return saved;
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new ProfileError(409, "That username is already reserved. Choose another.");
      throw error;
    }
  }
  async avatar(
    owner: string,
    byUsername = false,
  ): Promise<{ mode: AvatarMode; key: string | null; hash: string | null } | null> {
    const result = await this.pool.query<{
      mode: AvatarMode;
      key: string | null;
      hash: string | null;
    }>(
      `SELECT avatar_mode AS mode, avatar_key AS key, avatar_hash AS hash FROM breadcrumb_profiles.profiles
       WHERE ${byUsername ? "username=$1 AND visibility='public'" : "owner_id=$1"}`,
      [owner],
    );
    return result.rows[0] ?? null;
  }
  async uploadAvatar(owner: string, key: string) {
    const result = await this.pool.query<Profile>(
      `UPDATE breadcrumb_profiles.profiles SET
      avatar_mode='upload', avatar_key=$2, avatar_hash=NULL, updated_at=now()
      WHERE owner_id=$1 RETURNING ${columns}`,
      [owner, key],
    );
    const saved = profile(result.rows[0]);
    if (!saved) throw new ProfileError(400, "Reserve a username before adding a photo.");
    return saved;
  }
  async avatarGarbage() {
    const result = await this.pool.query<{ key: string }>(
      "SELECT key FROM breadcrumb_profiles.avatar_garbage ORDER BY created_at LIMIT 10",
    );
    return result.rows.map((row) => row.key);
  }
  async queueAvatarGarbage(key: string) {
    await this.pool.query(
      "INSERT INTO breadcrumb_profiles.avatar_garbage (key) VALUES ($1) ON CONFLICT DO NOTHING",
      [key],
    );
  }
  async avatarRemoved(key: string) {
    await this.pool.query("DELETE FROM breadcrumb_profiles.avatar_garbage WHERE key=$1", [key]);
  }
  async limit(owner: string) {
    const result = await this.pool.query<{ attempts: number }>(
      `
      INSERT INTO breadcrumb_profiles.limits AS l (owner_id,window_started,attempts) VALUES ($1,now(),1)
      ON CONFLICT (owner_id) DO UPDATE SET
        attempts=CASE WHEN l.window_started < now()-interval '1 minute' THEN 1 ELSE l.attempts+1 END,
        window_started=CASE WHEN l.window_started < now()-interval '1 minute' THEN now() ELSE l.window_started END
      RETURNING attempts`,
      [owner],
    );
    if (result.rows[0].attempts > 60)
      throw new ProfileError(429, "Too many profile requests. Try again in a minute.");
  }
}
async function json(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ProfileError(400, "A JSON profile is required.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    body = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new ProfileError(413, "Profile is too large.");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError(400, "A valid JSON profile is required.");
  } finally {
    reader.releaseLock();
  }
}
const response = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
export class ProfileAPI {
  constructor(
    private repo: ProfileRepository,
    private session: (request: Request) => Promise<Session>,
    private catalog: () => Promise<AppEntry[]> = appCatalog,
    private env = process.env,
    private cleanup: () => Promise<void> = async () => {},
  ) {}
  private async owner(request: Request) {
    const session = await this.session(request);
    if (!session?.user.emailVerified || !allowedEmail(session.user.email, this.env))
      throw new ProfileError(401, "Sign in to manage your profile.");
    return session.user;
  }
  async handle(request: Request, action: "owner" | "availability" | "public", name?: string) {
    try {
      if (action === "public") {
        let username: string;
        try {
          username = profileUsername(name ?? "");
        } catch {
          return response({ error: "Profile not found." }, 404);
        }
        const result = publicProfile(await this.repo.find(username), await this.catalog());
        return result
          ? response({ profile: result })
          : response({ error: "Profile not found." }, 404);
      }
      const user = await this.owner(request);
      const owner = user.id;
      if (action === "availability") {
        await this.repo.limit(owner);
        const username = profileUsername(new URL(request.url).searchParams.get("username") ?? "");
        return response({ username, available: await this.repo.available(username) });
      }
      if (request.method === "GET") {
        await this.cleanup().catch(() => {});
        return response({ profile: await this.repo.get(owner) });
      }
      const origin = this.env.PUBLIC_URL ?? this.env.BETTER_AUTH_URL ?? new URL(request.url).origin;
      if (request.headers.get("origin") !== new URL(origin).origin)
        throw new ProfileError(403, "Same-origin request required.");
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new ProfileError(415, "Send your profile as JSON.");
      await this.repo.limit(owner);
      const patch = profilePatch(await json(request), await this.catalog());
      const hash =
        patch.avatarMode === "gravatar"
          ? createHash("sha256").update(user.email.trim().toLowerCase()).digest("hex")
          : undefined;
      const saved = await this.repo.save(owner, patch, hash);
      await this.cleanup().catch(() => {});
      return response({ profile: saved });
    } catch (error) {
      const result =
        error instanceof ProfileError
          ? response({ error: error.message }, error.status)
          : response({ error: "Profiles are temporarily unavailable." }, 503);
      if (error instanceof ProfileError && error.status === 429)
        result.headers.set("Retry-After", "60");
      return result;
    }
  }
}
let repository: PostgresProfiles | undefined;
export function getProfileRepository() {
  if (!process.env.DATABASE_URL) throw Error("Profile database is not configured");
  return (repository ??= new PostgresProfiles(platformDB()));
}
export const profileSession = (request: Request) =>
  getAuth().api.getSession({ headers: request.headers });
let api: ProfileAPI | undefined;
export function getProfileAPI() {
  return (api ??= new ProfileAPI(
    getProfileRepository(),
    profileSession,
    appCatalog,
    process.env,
    async () => (await import("./profile-avatars")).cleanupAvatarObjects(),
  ));
}
export async function profileRoute(
  request: Request,
  action: "owner" | "availability" | "public",
  name?: string,
) {
  try {
    return await getProfileAPI().handle(request, action, name);
  } catch {
    return response({ error: "Profiles are temporarily unavailable." }, 503);
  }
}
