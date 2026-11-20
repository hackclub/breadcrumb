import { authorizationDetails } from "../lib/authorization";
// Local, synthetic browser/Go-engine integration harness. Never reads a real library.
// Build the Go engine first; run with `bun web/scripts/desktop-sync-smoke.ts`.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service, sha } from "../lib/service";
import { MemoryStore } from "../lib/store";
import { createAuthAccess, type BreadcrumbAuth } from "../lib/auth";
import { memoryAuth } from "./support/memory-auth";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
const directory =
  process.env.SMOKE_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "breadcrumb-sync-smoke-")));
await mkdir(directory, { recursive: true, mode: 0o700 });
const control = process.env.SMOKE_CONTROL ?? randomBytes(32).toString("hex"),
  email = "friend@example.com";
const store = new MemoryStore();
let link = "";
let refreshes = 0;
const env = { PUBLIC_URL: "", ALLOWED_EMAILS: email, NODE_ENV: "test" as const };
let auth: BreadcrumbAuth;
const service = new Service(
  store,
  env,
  createAuthAccess(() => auth, env),
);
const dates = [180, 120, 60].map((seconds) => Date.now() / 1000 - 978307200 - seconds);
const observations = dates.map((date) => ({
  id: randomUUID(),
  date,
  app: "Synthetic editor",
  bundleID: "test.synthetic",
  windowTitle: "Synthetic capture",
  sampleIntervalSeconds: 60,
}));
await writeFile(
  join(directory, "library.json"),
  JSON.stringify({ version: 1, observations, clips: [], markers: [] }),
);
for (const [index, row] of observations.entries())
  await writeFile(
    join(directory, row.id + ".json"),
    JSON.stringify({
      jpeg: index === 0 ? Buffer.alloc(3300000, 1).toString("base64") : "AQID",
      tree: [{ role: "AXWindow", label: "Synthetic only", depth: 0 }],
      screenText: "Synthetic only",
    }),
  );
await writeFile(
  join(directory, "settings.json"),
  JSON.stringify({
    retentionHours: 0,
    storageGiB: 20,
    savedStorageGiB: 4,
    intervalSeconds: 15,
    captureChanges: false,
    minimumEventInterval: 10,
    recognizeText: true,
    jpegQuality: 0.65,
    maximumWidth: 0,
  }),
);
const helper = join(directory, "synthetic-helper");
await writeFile(
  helper,
  `#!/usr/bin/env bun\nlet text="";for await(const chunk of Bun.stdin.stream()){text+=new TextDecoder().decode(chunk);let i;while((i=text.indexOf("\\n"))>=0){const request=JSON.parse(text.slice(0,i));text=text.slice(i+1);console.log(JSON.stringify({ok:true,recordingPreference:false,contextKey:"synthetic",capabilities:{screenshot:true,accessibility:true,ocr:true,windowContext:true,exclusions:"synthetic",backend:"Synthetic test adapter",permission:"granted"},...(request.command==="capture"?{record:{app:"Synthetic editor",bundleID:"test.synthetic",windowTitle:"Synthetic new capture"},payload:{jpeg:"AQID",tree:[{role:"AXWindow",depth:0,label:"Synthetic only"}]}}:{})}));}}`,
);
await chmod(helper, 0o700);
let child: ReturnType<typeof Bun.spawn>;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
function spawn() {
  child = Bun.spawn(
    [
      process.env.SMOKE_ENGINE ?? "/tmp/breadcrumb-sync-engine",
      "--data-dir",
      directory,
      "--capture-helper",
      helper,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const output = child.stdout;
  if (!output || typeof output === "number") throw Error("No engine output");
  void (async () => {
    let buffer = "";
    for await (const chunk of output) {
      buffer += new TextDecoder().decode(chunk);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const response = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const task = pending.get(response.id);
        pending.delete(response.id);
        if (response.error) task?.reject(Error(response.error));
        else task?.resolve(response.result);
      }
    }
  })();
}
function command(name: string, args: unknown = {}) {
  return new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    const input = child.stdin;
    if (!input || typeof input === "number") throw Error("No engine input");
    input.write(JSON.stringify({ id, command: name, args }) + "\n");
  });
}
spawn();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.SMOKE_PORT ?? 0),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__test/")) {
      if (request.headers.get("x-test-key") !== control)
        return new Response("Unauthorized", { status: 401 });
      try {
        if (url.pathname === "/__test/link") return Response.json({ link });
        if (url.pathname === "/__test/start")
          return Response.json(await command("beginSignIn", { server: env.PUBLIC_URL }));
        if (url.pathname === "/__test/state") return Response.json(await command("state"));
        if (url.pathname === "/__test/toggle") return Response.json(await command("toggle"));
        if (url.pathname === "/__test/disconnect")
          return Response.json(await command("disconnect"));
        if (url.pathname === "/__test/expire") {
          child.kill();
          await child.exited;
          const connection = JSON.parse(await readFile(join(directory, "connection.json"), "utf8"));
          connection.expires = "2000-01-01T00:00:00Z";
          await writeFile(join(directory, "connection.json"), JSON.stringify(connection), {
            mode: 0o600,
          });
          spawn();
          return Response.json({ ok: true });
        }
        if (url.pathname === "/__test/restart") {
          child.kill();
          await child.exited;
          spawn();
          return Response.json({ ok: true });
        }
        if (url.pathname === "/__test/metrics")
          return Response.json({
            refreshes,
            captures: [...store.data.keys()].filter((key) =>
              key.startsWith(`captures/${sha(email)}/`),
            ).length,
            chunks: [...store.data.keys()].filter((key) => key.startsWith("incoming/")).length,
          });
      } catch {
        return new Response("Synthetic harness command failed", {
          status: 500,
        });
      }
    }
    if (url.pathname === "/api/authorization") return authorizationDetails(request, auth);
    if (url.pathname.startsWith("/api/auth/")) {
      if (
        url.pathname.endsWith("/oauth2/token") &&
        (await request.clone().text()).includes("grant_type=refresh_token")
      )
        refreshes++;
      return auth.handler(request);
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/api/auth")
      return oauthProviderAuthServerMetadata(auth)(request);
    if (url.pathname.startsWith("/v1/")) return service.dispatch(request);
    const upstream = new URL(
      url.pathname + url.search,
      process.env.SMOKE_WEB_URL ?? "http://127.0.0.1:3000",
    );
    const response = await fetch(new Request(upstream, request));
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(response.body, { status: response.status, headers });
  },
});
env.PUBLIC_URL = `http://127.0.0.1:${server.port}`;
auth = memoryAuth({
  baseURL: env.PUBLIC_URL,
  env,
  send: async (_email, url) => {
    link = url;
  },
});
await auth.$context;

console.log("Synthetic browser sync harness ready on " + env.PUBLIC_URL);
process.on("SIGTERM", () => {
  child.kill();
  server.stop();
  process.exit(0);
});
