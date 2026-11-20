import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { R2Store, type Store } from "./store";
import {
  ProfileError,
  PostgresProfiles,
  getProfileRepository,
  profileSession,
  profileUsername,
  type AvatarMode,
  type Profile,
} from "./profiles";
import { allowedEmail } from "./auth";

type Avatar = { mode: AvatarMode; key: string | null; hash: string | null };
export type AvatarFetch = (url: string, options: RequestInit) => Promise<Response>;
type Session = { user: { id: string; email: string; emailVerified: boolean } } | null;
export type AvatarRepository = Pick<
  PostgresProfiles,
  | "get"
  | "avatar"
  | "uploadAvatar"
  | "save"
  | "limit"
  | "avatarGarbage"
  | "avatarRemoved"
  | "queueAvatarGarbage"
>;
const MAX = 2 * 1024 * 1024;
const validKey = (key: string) => /^profile-avatars\/[a-f0-9]{64}\/[a-f0-9-]{36}\.webp$/.test(key);

/** Decode genuine raster input, bound decompression work and discard all original metadata. */
export async function avatarImage(input: Uint8Array) {
  if (!input.length || input.length > MAX)
    throw new ProfileError(413, "Choose an image no larger than 2 MiB.");
  const bytes = Buffer.from(input);
  const raster =
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
  if (!raster)
    throw new ProfileError(
      415,
      "Choose a JPEG, PNG or WebP image. SVG and animated images are not supported.",
    );
  try {
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" }).timeout({
      seconds: 5,
    });
    const meta = await image.metadata();
    if (
      !["jpeg", "png", "webp"].includes(meta.format ?? "") ||
      (meta.pages ?? 1) !== 1 ||
      !meta.width ||
      !meta.height ||
      meta.width > 8192 ||
      meta.height > 8192
    )
      throw new Error("Unsupported image");
    return await image
      .rotate()
      .resize(256, 256, { fit: "cover" })
      .toColourspace("srgb")
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ProfileError(
      422,
      "This image could not be processed. Choose a smaller, non-animated JPEG, PNG or WebP.",
    );
  }
}
async function boundedBody(response: Response | Request, max: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new ProfileError(400, "An image is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ProfileError(413, "Choose an image no larger than 2 MiB.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}
async function uploadImage(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data;"))
    throw new ProfileError(415, "Upload an image file.");
  const body = await boundedBody(request, MAX + 16384);
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": request.headers.get("content-type")! },
      body,
    }).formData();
  } catch {
    throw new ProfileError(400, "Upload one image file.");
  }
  const file = form.get("avatar");
  if (
    !file ||
    typeof file === "string" ||
    form.getAll("avatar").length !== 1 ||
    [...form.keys()].some((key) => key !== "avatar")
  )
    throw new ProfileError(400, "Upload one image in the avatar field.");
  return avatarImage(new Uint8Array(await file.arrayBuffer()));
}
export async function cleanupAvatarObjects(
  repo: AvatarRepository = getProfileRepository(),
  store?: Store,
) {
  const keys = await repo.avatarGarbage();
  if (!keys.length) return;
  const storage = store ?? getStore();
  for (const key of keys) {
    if (!validKey(key)) continue;
    try {
      await storage.remove(key);
      await repo.avatarRemoved(key);
    } catch {
      /* Durable queue retains failed deletes for the next owner request. */
    }
  }
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
const missing = () => json({ error: "Avatar not found." }, 404);
function sameAvatar(a: Avatar, b: Avatar | null) {
  return b && a.mode === b.mode && a.key === b.key && a.hash === b.hash;
}
export class AvatarAPI {
  constructor(
    private repo: AvatarRepository,
    private storage: () => Store,
    private session: (request: Request) => Promise<Session>,
    private env = process.env,
    private fetcher: AvatarFetch = fetch,
  ) {}
  async handle(request: Request, username?: string) {
    try {
      let owner = "",
        lookup = "";
      if (username !== undefined) {
        try {
          lookup = profileUsername(username);
        } catch {
          return missing();
        }
      } else {
        const session = await this.session(request);
        if (!session?.user.emailVerified || !allowedEmail(session.user.email, this.env))
          throw new ProfileError(401, "Sign in to manage your profile photo.");
        owner = session.user.id;
        lookup = owner;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const avatar = await this.repo.avatar(lookup, username !== undefined);
        if (!avatar || avatar.mode === "none") return missing();
        let image: Uint8Array | null = null;
        if (avatar.mode === "upload" && avatar.key && validKey(avatar.key))
          image = await this.storage().get(avatar.key);
        if (avatar.mode === "gravatar" && avatar.hash && /^[a-f0-9]{64}$/.test(avatar.hash)) {
          // Fixed provider only. Redirects, arbitrary remote URLs, email and hashes
          // never reach the viewer's browser. Each request respects current opt-in.
          const remote = await this.fetcher(
            `https://www.gravatar.com/avatar/${avatar.hash}?s=256&d=404&r=g`,
            {
              headers: { Accept: "image/webp,image/png,image/jpeg" },
              redirect: "error",
              credentials: "omit",
              cache: "no-store",
              signal: AbortSignal.timeout(5000),
            },
          );
          if (!remote.ok) return missing();
          image = await avatarImage(await boundedBody(remote, MAX));
        }
        if (!image || !sameAvatar(avatar, await this.repo.avatar(lookup, username !== undefined)))
          return missing();
        return new Response(Buffer.from(image), {
          headers: {
            "Content-Type": "image/webp",
            "Content-Length": String(image.byteLength),
            "Cache-Control": "no-store",
            Vary: "Cookie",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Disposition": 'inline; filename="avatar.webp"',
          },
        });
      }
      if (!owner) return missing();
      const origin = this.env.PUBLIC_URL ?? this.env.BETTER_AUTH_URL ?? new URL(request.url).origin;
      if (request.headers.get("origin") !== new URL(origin).origin)
        throw new ProfileError(403, "Same-origin request required.");
      await this.repo.limit(owner);
      if (!(await this.repo.get(owner)))
        throw new ProfileError(400, "Reserve a username before adding a photo.");
      let saved: Profile;
      if (request.method === "DELETE") saved = await this.repo.save(owner, { avatarMode: "none" });
      else if (request.method === "POST") {
        const image = await uploadImage(request);
        const key = `profile-avatars/${createHash("sha256").update(owner).digest("hex")}/${randomUUID()}.webp`;
        const store = this.storage();
        if (!(await store.create(key, image)))
          throw new ProfileError(503, "Your photo could not be saved. Try again.");
        try {
          saved = await this.repo.uploadAvatar(owner, key);
        } catch (error) {
          try {
            await store.remove(key);
          } catch {
            await this.repo.queueAvatarGarbage(key).catch(() => {});
          }
          throw error;
        }
      } else throw new ProfileError(405, "Method not allowed.");
      await cleanupAvatarObjects(this.repo, this.storage()).catch(() => {});
      return json({ profile: saved });
    } catch (error) {
      const status = error instanceof ProfileError ? error.status : 503;
      const result = json(
        {
          error:
            error instanceof ProfileError
              ? error.message
              : "Profile photos are temporarily unavailable.",
        },
        status,
      );
      if (status === 429) result.headers.set("Retry-After", "60");
      return result;
    }
  }
}
let store: Store | undefined;
const getStore = () => (store ??= new R2Store());
let api: AvatarAPI | undefined;
export function avatarRoute(request: Request, username?: string) {
  try {
    api ??= new AvatarAPI(getProfileRepository(), getStore, profileSession);
    return api.handle(request, username);
  } catch {
    return Promise.resolve(json({ error: "Profile photos are temporarily unavailable." }, 503));
  }
}
