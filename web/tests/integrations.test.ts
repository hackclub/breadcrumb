import { openAPI } from "../lib/openapi";
import { authorizationDetails } from "../lib/authorization";
import { test, expect } from "bun:test";
import { randomBytes, createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { memoryAuth } from "../scripts/support/memory-auth";
import { createDataAccess } from "../lib/data-access";
import { MemoryStore } from "../lib/store";
import { recordSynced } from "../lib/sync";
import { readActivity } from "../lib/activity-api";
import { createBreadcrumbMCP } from "../lib/mcp";
import { participantID, createAuthAccess } from "../lib/auth";
import { integrationsAPI } from "../lib/integrations-api";
import { APIProblem } from "../lib/api-http";
const root = "https://breadcrumb.example";
async function oauth(resource = "/api/v1", scopes = "time:read apps:read projects:read") {
  let link = "";
  const auth = memoryAuth({
    baseURL: root,
    env: { NODE_ENV: "test" },
    send: async (_email, url) => {
      link = url;
    },
  });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(root + "/api/auth" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Origin: root, "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  await call("/sign-in/magic-link", { email: "member@example.invalid", callbackURL: root });
  const verified = await auth.handler(new Request(link));
  const cookie = verified.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const registered = await call("/oauth2/register", {
    client_name: "Time assistant",
    application_type: "native",
    token_endpoint_auth_method: "none",
    redirect_uris: ["http://127.0.0.1:49201/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: scopes,
    resources: [root + resource],
  });
  expect(registered.status).toBe(201);
  const client = await registered.json(),
    verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: client.redirect_uris[0],
    scope: scopes,
    resource: root + resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(24).toString("hex"),
    prompt: "consent",
  });
  const start = await call("/oauth2/authorize?" + query, undefined, {
    Cookie: cookie,
    Accept: "text/html",
  });
  const consent = new URL(start.headers.get("location")!, root);
  expect(consent.pathname).toBe("/connect");
  const details = await authorizationDetails(
    new Request(root + "/api/authorization" + consent.search, { headers: { Cookie: cookie } }),
    auth,
  );
  expect(details.status).toBe(200);
  expect((await details.json()).scopes).toEqual(scopes.split(" "));
  const tampered = new URL(consent);
  tampered.searchParams.set("scope", "screenshots:read");
  expect(
    (await authorizationDetails(new Request(tampered, { headers: { Cookie: cookie } }), auth))
      .status,
  ).toBe(400);
  const accepted = await call(
    "/oauth2/consent",
    { accept: true, oauth_query: consent.search.slice(1) },
    { Cookie: cookie },
  );
  const callback = new URL((await accepted.json()).url);
  const response = await auth.handler(
    new Request(root + "/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: callback.searchParams.get("code")!,
        code_verifier: verifier,
        redirect_uri: client.redirect_uris[0],
        resource: root + resource,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const token = (await response.json()).access_token;
  const access = createDataAccess(() => auth, { PUBLIC_URL: root, NODE_ENV: "test" });
  const request = (path = resource) =>
    new Request(root + path, { headers: { Authorization: `Bearer ${token}` } });
  return { auth, access, request, cookie, token };
}
test("read grants enforce audience, scopes, live revocation and no cookie-only third-party access", async () => {
  const f = await oauth("/api/v1", "time:read");
  expect((await f.access(f.request(), "/api/v1")).scopes).toEqual(["time:read"]);
  expect(JSON.parse(Buffer.from(f.token.split(".")[1], "base64url").toString())).not.toHaveProperty(
    "email",
  );
  await expect(f.access(f.request(), "/mcp")).rejects.toMatchObject({ status: 401 });
  await expect(f.access(f.request(), "/api/v1", ["apps:read"])).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    f.access(new Request(root + "/api/v1/activity", { headers: { Cookie: f.cookie } }), "/api/v1"),
  ).rejects.toMatchObject({ status: 401 });
  const grants = await f.auth.api.getOAuthConsents({ headers: new Headers({ Cookie: f.cookie }) });
  await f.auth.api.deleteOAuthConsent({
    headers: new Headers({ Cookie: f.cookie, Origin: root }),
    body: { id: grants[0].id },
  });
  await expect(f.access(f.request(), "/api/v1")).rejects.toMatchObject({
    status: 401,
    code: "revoked_connection",
  });
});
test("activity pagination is account-bound and strips ungranted app/project metadata", async () => {
  const store = new MemoryStore(),
    participant = participantID("member@example.invalid");
  const day = "2026-01-02",
    date = Date.parse(day + "T12:00:00Z") / 1000 - 978307200;
  for (const [id, offset] of [
    ["a", 0],
    ["b", 60],
  ] as const)
    await recordSynced(
      store,
      participant,
      {
        id,
        date: date + offset,
        app: "Editor",
        bundleID: "app.editor",
        context: { project: "Private project" },
      },
      "2026-01-02T13:00:00Z",
    );
  const principal = { owner: "owner", participant, client: "client", scopes: ["time:read"] };
  const result = await readActivity(
    store,
    principal,
    { from: day, to: "2026-01-04", limit: 1 },
    undefined,
  );
  expect(result.nextCursor).toBe("2026-01-03");
  expect(result.days[0].seconds).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain("Editor");
  expect(JSON.stringify(result)).not.toContain("Private project");
  const allowed = await readActivity(
    store,
    { ...principal, scopes: ["time:read", "apps:read"] },
    { from: day, to: day },
    undefined,
  );
  expect(allowed.days[0]).toHaveProperty("apps");
  expect(allowed.days[0]).not.toHaveProperty("projects");
  const other = await readActivity(
    store,
    { ...principal, participant: participantID("other@example.invalid") },
    { from: day, to: day },
    undefined,
  );
  expect(other.days[0].seconds).toBe(0);
  await expect(
    readActivity(store, principal, { from: day, to: day, timeZone: "Invalid/Zone" }, undefined),
  ).rejects.toBeInstanceOf(APIProblem);
});
test("official MCP clients negotiate modern and legacy protocols with scoped structured results", async () => {
  const old = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = root;
  try {
    for (const mode of [{ pin: "2026-07-28" }, "legacy"] as const) {
      const f = await oauth("/mcp", "time:read"),
        store = new MemoryStore();
      const serve = createBreadcrumbMCP({
        store: () => store,
        authorize: f.access,
        limit: async () => ({}),
      });
      const client = new Client(
        { name: "breadcrumb-test", version: "1.0.0" },
        { versionNegotiation: { mode } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(root + "/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${f.token}` } },
        fetch: async (input, init) => serve(new Request(input, init)),
      });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(["breadcrumb_get_activity"]);
        const result = await client.callTool({
          name: "breadcrumb_get_activity",
          arguments: { from: "2026-01-02", to: "2026-01-02" },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toHaveProperty("days");
      } finally {
        await client.close();
      }
    }
  } finally {
    if (old === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = old;
  }
});
test("unknown API routes and methods return recoverable problem details", async () => {
  const response = await integrationsAPI(
    new Request(root + "/api/v1/does-not-exist"),
    new MemoryStore(),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("Content-Type")).toContain("application/problem+json");
  expect(await response.json()).toHaveProperty("resolution");
  const method = await integrationsAPI(
    new Request(root + "/api/v1/activity", { method: "POST" }),
    new MemoryStore(),
  );
  expect(method.status).toBe(405);
  expect(method.headers.get("Allow")).toBe("GET");
});

test("disconnecting a desktop grant also stops uploads immediately", async () => {
  const f = await oauth("/v1", "email captures:sync");
  const access = createAuthAccess(() => f.auth, { PUBLIC_URL: root, NODE_ENV: "test" });
  expect(await access.upload(f.request("/v1/ingest"))).not.toBeNull();
  const headers = new Headers({ Cookie: f.cookie, Origin: root });
  const grants = await f.auth.api.getOAuthConsents({ headers });
  await f.auth.api.deleteOAuthConsent({ headers, body: { id: grants[0].id } });
  expect(await access.upload(f.request("/v1/ingest"))).toBeNull();
});

test("published API contract references resolve and retain the permission model", () => {
  const old = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = root;
  try {
    const document = openAPI();
    expect(document.openapi).toBe("3.2.1");
    const visit = (value: unknown) => {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === "object")
        for (const [key, item] of Object.entries(value)) {
          if (key === "$ref" && typeof item === "string" && item.startsWith("#/")) {
            let resolved: unknown = document;
            for (const part of item.slice(2).split("/"))
              resolved = (resolved as Record<string, unknown>)[part];
            expect(resolved).toBeDefined();
          } else visit(item);
        }
    };
    visit(document);
    expect(document.paths["/api/v1/shares"].post.security).toEqual([{ browserSession: [] }]);
  } finally {
    if (old === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = old;
  }
});

test("agent read permission is independent of time history and resource-bound", async () => {
  const f = await oauth("/api/v1", "agents:read");
  expect((await f.access(f.request(), "/api/v1", ["agents:read"])).scopes).toEqual(["agents:read"]);
  await expect(f.access(f.request(), "/api/v1", ["time:read"])).rejects.toMatchObject({
    status: 403,
  });
  await expect(f.access(f.request(), "/mcp", ["agents:read"])).rejects.toMatchObject({
    status: 401,
  });
});

test("MCP exposes only the agent usage tool for an agents-only grant", async () => {
  const previous = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = root;
  try {
    const f = await oauth("/mcp", "agents:read"),
      store = new MemoryStore(),
      serve = createBreadcrumbMCP({
        store: () => store,
        authorize: f.access,
        limit: async () => ({}),
      });
    const client = new Client(
      { name: "usage-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(root + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${f.token}` } },
      fetch: async (input, init) => serve(new Request(input, init)),
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "breadcrumb_get_agent_usage",
      ]);
      const result = await client.callTool({
        name: "breadcrumb_get_agent_usage",
        arguments: { range: 7, timeZone: "UTC" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty("hours");
      expect(JSON.stringify(result)).not.toContain("sessionId");
    } finally {
      await client.close();
    }
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previous;
  }
});
