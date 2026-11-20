import { test, expect } from "bun:test";
import {
  ProfileAPI,
  ProfileError,
  profilePatch,
  profileUsername,
  publicProfile,
  type Profile,
  type ProfileRepository,
} from "../lib/profiles";
import { appSeed } from "../lib/apps";
const sample: Profile = {
  username: "friend_123",
  displayName: "Friend",
  bio: "Building things",
  visibility: "public",
  shareApps: false,
  apps: [appSeed[0].id],
  createdAt: "2026-11-19T00:00:00Z",
  updatedAt: "2026-11-19T00:00:00Z",
};
function fixture(verified = true) {
  let owner = "";
  let value: Profile | null = sample;
  const repo: ProfileRepository = {
    async get(id) {
      owner = id;
      return value;
    },
    async find() {
      return value;
    },
    async available() {
      return false;
    },
    async save(id, patch) {
      owner = id;
      value = { ...sample, ...patch };
      return value;
    },
    async limit() {},
  };
  const api = new ProfileAPI(
    repo,
    async () => ({
      user: { id: "stable-auth-user", email: "friend@example.com", emailVerified: verified },
    }),
    async () => appSeed,
    { PUBLIC_URL: "https://breadcrumb.example", NODE_ENV: "test" },
  );
  const request = (body?: unknown, origin = "https://breadcrumb.example") =>
    new Request("https://breadcrumb.example/api/profile", {
      method: body ? "PATCH" : "GET",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { api, repo, request, owner: () => owner };
}
test("username validation normalizes case, blocks protected names and rejects path/confusable input", () => {
  expect(profileUsername("  Friend_123  ")).toBe("friend_123");
  for (const name of ["admin", "SUPPORT", "ab", "../friend", "frïend", "_friend", "a".repeat(25)])
    expect(() => profileUsername(name)).toThrow(ProfileError);
  expect(() => profilePatch({ owner_id: "other-user", username: "friend" }, appSeed)).toThrow(
    ProfileError,
  );
  expect(() => profilePatch({ apps: ["https://tracker.example/icon.png"] }, appSeed)).toThrow(
    ProfileError,
  );
});
test("private profiles and disabled app sharing cannot leak through the public projection", () => {
  expect(publicProfile({ ...sample, visibility: "private", shareApps: true }, appSeed)).toBeNull();
  const minimal = publicProfile(
    { ...sample, email: "secret@example.com", owner_id: "secret" } as Profile,
    appSeed,
  )!;
  expect(Object.keys(minimal).sort()).toEqual(["bio", "displayName", "username"]);
  const shared = publicProfile({ ...sample, shareApps: true }, appSeed)!;
  expect(shared.apps?.map((app) => app.id)).toEqual(sample.apps);
  expect("visibility" in shared).toBe(false);
});
test("profile endpoints take ownership from verified Better Auth identity and reject ownership injection", async () => {
  const f = fixture();
  expect((await f.api.handle(f.request(), "owner")).status).toBe(200);
  expect(f.owner()).toBe("stable-auth-user");
  expect(
    (await f.api.handle(f.request({ owner_id: "other-user", bio: "test" }), "owner")).status,
  ).toBe(400);
  expect((await fixture(false).api.handle(f.request({ bio: "test" }), "owner")).status).toBe(401);
  const anonymous = new ProfileAPI(f.repo, async () => null);
  expect((await anonymous.handle(f.request(), "owner")).status).toBe(401);
  expect((await anonymous.handle(f.request(), "availability")).status).toBe(401);
});
test("profile writes enforce origin, body bounds and immediate no-store privacy responses", async () => {
  const f = fixture();
  expect(
    (await f.api.handle(f.request({ bio: "new" }, "https://attacker.example"), "owner")).status,
  ).toBe(403);
  const oversized = f.request({ bio: "a".repeat(9000) });
  expect((await f.api.handle(oversized, "owner")).status).toBe(413);
  const saved = await f.api.handle(f.request({ visibility: "private", shareApps: true }), "owner");
  expect(saved.status).toBe(200);
  const hidden = await f.api.handle(f.request(), "public", sample.username);
  const absent = await f.api.handle(f.request(), "public", "invalid/name");
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toEqual(await absent.json());
  expect(hidden.headers.get("cache-control")).toBe("no-store");
});
test("public app projection includes only selected catalog entries and request throttles stay generic", async () => {
  const f = fixture();
  await f.api.handle(f.request({ shareApps: true, apps: [appSeed[0].id] }), "owner");
  const result = await f.api.handle(f.request(), "public", sample.username);
  expect((await result.json()).profile.apps.map((app: { id: string }) => app.id)).toEqual([
    appSeed[0].id,
  ]);
  f.repo.limit = async () => {
    throw new ProfileError(429, "Too many profile requests. Try again in a minute.");
  };
  const limited = await f.api.handle(f.request(), "availability");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
});
