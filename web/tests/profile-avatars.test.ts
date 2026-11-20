import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  AvatarAPI,
  avatarImage,
  cleanupAvatarObjects,
  type AvatarRepository,
  type AvatarFetch,
} from "../lib/profile-avatars";
import {
  ProfileError,
  profilePatch,
  profileLink,
  publicProfile,
  type Profile,
  type AvatarMode,
} from "../lib/profiles";
import { MemoryStore } from "../lib/store";
import { appSeed } from "../lib/apps";
const base = "https://breadcrumb.example";
const owner = "synthetic-owner",
  hash = "a".repeat(64);
const key = `profile-avatars/${hash}/00000000-0000-4000-8000-000000000001.webp`;
const sample: Profile = {
  username: "avatar_test",
  displayName: "Avatar",
  bio: "",
  visibility: "public",
  shareApps: false,
  apps: [],
  avatarMode: "upload",
  avatarURL: "/api/profile/avatar?v=1",
  githubUrl: "",
  websiteUrl: "",
  createdAt: "2026-11-19T00:00:00Z",
  updatedAt: "2026-11-19T00:00:00Z",
};
const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#123456" } })
  .png()
  .toBuffer();
function fixture(mode: AvatarMode = "upload", authenticated = true, fetcher: AvatarFetch = fetch) {
  let value: Profile = { ...sample, avatarMode: mode };
  let avatar = {
    mode,
    key: mode === "upload" ? key : null,
    hash: mode === "gravatar" ? hash : null,
  };
  const pending = new Set<string>();
  const store = new MemoryStore();
  if (mode === "upload") store.data.set(key, png);
  const repo: AvatarRepository = {
    async get(id) {
      return id === owner ? value : null;
    },
    async avatar(id, byUsername = false) {
      return (byUsername ? id === value.username && value.visibility === "public" : id === owner)
        ? { ...avatar }
        : null;
    },
    async save(id, patch) {
      if (id !== owner) throw new ProfileError(404, "Missing");
      if (avatar.key) pending.add(avatar.key);
      value = { ...value, ...patch };
      avatar = { mode: value.avatarMode, key: null, hash: null };
      return value;
    },
    async uploadAvatar(id, newKey) {
      if (id !== owner) throw new Error("Wrong owner");
      if (avatar.key) pending.add(avatar.key);
      avatar = { mode: "upload", key: newKey, hash: null };
      value = { ...value, avatarMode: "upload", avatarURL: "/api/profile/avatar?v=2" };
      return value;
    },
    async limit() {},
    async avatarGarbage() {
      return [...pending];
    },
    async avatarRemoved(key) {
      pending.delete(key);
    },
    async queueAvatarGarbage(key) {
      pending.add(key);
    },
  };
  const api = new AvatarAPI(
    repo,
    () => store,
    async () =>
      authenticated
        ? { user: { id: owner, email: "synthetic@example.com", emailVerified: true } }
        : null,
    { PUBLIC_URL: base, NODE_ENV: "test" },
    fetcher,
  );
  return {
    api,
    repo,
    store,
    pending,
    get: () => value,
    hide: () => {
      value = { ...value, visibility: "private" };
    },
    request: (method = "GET", body?: BodyInit, origin = base) =>
      new Request(base + "/api/profile/avatar", { method, body, headers: { Origin: origin } }),
  };
}
function form(bytes: Uint8Array = png, type = "image/png") {
  const body = new FormData();
  body.set("avatar", new File([Buffer.from(bytes)], "photo.png", { type }));
  return body;
}
test("avatars are genuinely decoded, resized and stripped of metadata; SVG and bombs are rejected", async () => {
  const source = await sharp(png)
    .withExif({ IFD0: { Copyright: "Private synthetic metadata" } })
    .jpeg()
    .toBuffer();
  expect((await sharp(source).metadata()).exif).toBeDefined();
  const output = await avatarImage(source),
    meta = await sharp(output).metadata();
  expect([meta.format, meta.width, meta.height]).toEqual(["webp", 256, 256]);
  expect(meta.exif).toBeUndefined();
  await expect(
    avatarImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
  ).rejects.toBeInstanceOf(ProfileError);
  await expect(avatarImage(Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(ProfileError);
  const wide = await sharp({
    create: { width: 16384, height: 1, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await expect(avatarImage(wide)).rejects.toBeInstanceOf(ProfileError);
  await expect(avatarImage(Buffer.from([255, 216, 255, 0]))).rejects.toBeInstanceOf(ProfileError);
});
test("custom uploads require verified ownership and origin, replace private objects and delete cleanly", async () => {
  const anonymous = fixture("none", false);
  expect((await anonymous.api.handle(anonymous.request("POST", form()))).status).toBe(401);
  expect(anonymous.store.data.size).toBe(0);
  const f = fixture();
  expect((await f.api.handle(f.request("POST", form(), "https://attacker.example"))).status).toBe(
    403,
  );
  const saved = await f.api.handle(f.request("POST", form()));
  expect(saved.status).toBe(200);
  expect((await saved.json()).profile.avatarMode).toBe("upload");
  expect(f.store.data.has(key)).toBe(false);
  expect(f.store.data.size).toBe(1);
  const stored = [...f.store.data.values()][0];
  expect((await sharp(stored).metadata()).format).toBe("webp");
  const removed = await f.api.handle(f.request("DELETE"));
  expect(removed.status).toBe(200);
  expect(f.store.data.size).toBe(0);
  expect(f.pending.size).toBe(0);
});
test("private/deleted avatars are gated on every read, including a visibility change during storage access", async () => {
  const f = fixture();
  f.hide();
  expect((await f.api.handle(f.request(), sample.username)).status).toBe(404);
  const inFlight = fixture();
  inFlight.store.get = async () => {
    inFlight.hide();
    return png;
  };
  expect((await inFlight.api.handle(inFlight.request(), sample.username)).status).toBe(404);
  const ownerPreview = fixture();
  ownerPreview.hide();
  expect((await ownerPreview.api.handle(ownerPreview.request())).status).toBe(200);
});
test("Gravatar is opt-in, fixed-host proxied and metadata stripped without exposing provider hash or email", async () => {
  let target = "";
  let options: RequestInit | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    target = String(input);
    options = init;
    return new Response(png);
  }) as AvatarFetch;
  const f = fixture("gravatar", true, fetcher);
  const response = await f.api.handle(f.request(), sample.username);
  expect(response.status).toBe(200);
  expect(new URL(target).origin).toBe("https://www.gravatar.com");
  expect(options?.redirect).toBe("error");
  expect(options?.credentials).toBe("omit");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("image/webp");
  expect((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format).toBe("webp");
  const projection = publicProfile(f.get(), appSeed)!;
  expect(projection.avatarURL).toStartWith("/api/profiles/");
  expect(JSON.stringify(projection)).not.toContain(hash);
  expect(JSON.stringify(projection)).not.toContain("gravatar.com");
  const disabled = fixture("none", true, (() => {
    throw Error("Must not fetch");
  }) as AvatarFetch);
  expect((await disabled.api.handle(disabled.request(), sample.username)).status).toBe(404);
});
test("failed deletes remain queued and failed database writes do not orphan a newly uploaded photo", async () => {
  const f = fixture();
  f.pending.add(key);
  const remove = f.store.remove.bind(f.store);
  f.store.remove = async () => {
    throw Error("Synthetic outage");
  };
  await cleanupAvatarObjects(f.repo, f.store);
  expect(f.pending.has(key)).toBe(true);
  f.store.remove = remove;
  await cleanupAvatarObjects(f.repo, f.store);
  expect(f.pending.size).toBe(0);
  const failed = fixture("none");
  failed.repo.uploadAvatar = async () => {
    throw Error("Synthetic database outage");
  };
  expect((await failed.api.handle(failed.request("POST", form()))).status).toBe(503);
  expect(failed.store.data.size).toBe(0);
});
test("avatar mode cannot forge an upload and profile links reject remote-code/credential/GitHub path tricks", () => {
  expect(() => profilePatch({ avatarMode: "upload" }, appSeed)).toThrow(ProfileError);
  expect(profileLink("https://github.com/3kh0/", true)).toBe("https://github.com/3kh0");
  expect(profileLink("https://example.com/about?q=1")).toBe("https://example.com/about?q=1");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "http://example.com",
    "https://name:password@example.com",
  ])
    expect(() => profileLink(value)).toThrow(ProfileError);
  for (const value of [
    "https://github.com.evil.example/user",
    "https://github.com/user/repo",
    "https://github.com/user?tab=stars",
    "https://github.com:444/user",
  ])
    expect(() => profileLink(value, true)).toThrow(ProfileError);
  expect(profileLink("")).toBe("");
  const digest = createHash("sha256").update("synthetic@example.com").digest("hex");
  expect(profilePatch({ avatarMode: "gravatar" }, appSeed)).toEqual({ avatarMode: "gravatar" });
  expect(
    JSON.stringify(publicProfile({ ...sample, avatarMode: "gravatar" }, appSeed)),
  ).not.toContain(digest);
});
