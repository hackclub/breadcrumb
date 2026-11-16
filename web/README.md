# Hosted corpus service

Next.js App Router functions deployed to Vercel. R2 stores captures, credentials, upload chunks, and review jobs privately. Loops delivers one-time email links. The Go code in `engine/` runs locally inside the desktop app; it is not the hosted server.

## Configure

Copy `.env.example` to `.env.local` in this directory and fill in the credentials. Configure the same variables in Vercel production. Set project root to `web`, install command `bun install --frozen-lockfile`, and build command `bun run build`. Deploy from the repository root with `vc deploy --prod --scope hackclub`.

```sh
bun install --frozen-lockfile
bun run dev
```

Publish a Loops transactional template with a `loginUrl` variable. Invite contributors using comma-separated `ALLOWED_EMAILS`. Email links expire after 15 minutes and require an explicit Finish signing in action. Sessions last seven days; upload tokens last 30 days and can be revoked. Credentials are stored as hashes in R2. Auth POSTs require the configured origin; bearer upload endpoints do not accept session cookies as upload authorization. Rate limits use durable R2 slots across function instances.

Keep R2 public access disabled. Add lifecycle expiry rules for `incoming/` after one day and `auth/throttle/` after one day; expired credentials and claims are rejected even before lifecycle cleanup. Do not expire `captures/` or `review/results/` unless deliberately defining corpus retention. Captures use hashed account IDs, which are pseudonymous rather than anonymous. Never log credentials, magic links, or request payloads.

## API

- `GET /healthz` reports service configuration, not dependency health.
- `POST /auth/login` with `{email}` requests a link; invited and uninvited addresses both receive HTTP 202.
- `POST /auth/verify` with `{token}` consumes a link and sets an HttpOnly Secure session cookie.
- `GET /auth/me`, `POST /auth/logout`, and `POST /auth/token` use that session.
- `POST /auth/revoke` revokes its bearer upload token.
- `POST /v1/ingest` accepts `{schemaVersion:1,consent:true,record,payload}` with an upload bearer token. Payload contains base64 `jpeg`, filtered `tree`, and optional `screenText`. Capture UUIDs are idempotent; changed retries return 409.
- For payloads over 4 MiB, `POST /v1/uploads/start` accepts `{schemaVersion:1,consent:true,record,size,sha256}`. Upload binary chunks up to the returned `chunkSize` to `/v1/uploads/chunk?index=N` with `X-Upload-ID`, then `/v1/uploads/complete` with `{uploadId}`. Each function request stays below Vercel body limits. Maximum combined JSON payload is 12 MiB; JPEG is at most 8 MiB decoded.
- Review bearer credentials in `REVIEW_AGENT_TOKENS` authorize `/v1/review/claim`, `/submit`, `/index`, and `/context/:job`. Claims include an expiring signed `captureURL`; the Python worker fetches it without forwarding review credentials. Claims are leased and results immutable with evidence/provenance.
- `/api/cron/review` requires `CRON_SECRET` and reviews one pending capture per scheduled invocation through Vercel AI Gateway when `ENABLE_AI_REVIEWS=true`. Set `AI_GATEWAY_API_KEY` and a vision-capable `AI_GATEWAY_MODEL`. The default schedule is every 15 minutes. Review text is untrusted evidence; it never controls tools or shell commands.

The portal, desktop app, and `agents/breadcrumb.py upload UUID --server https://breadcrumb.hackclub.dev --consent` support explicit contribution. Prepare a browser bundle with `python3 agents/breadcrumb.py bundle UUID --output /tmp/contribution.json`.

`bun test` covers one-time auth, token revocation, origin enforcement, ingest idempotency/conflicts, multi-megabyte chunk uploads, and exclusive review leases. `scripts/live-smoke.ts` is an operator-only synthetic production check requiring private test configuration; it is not run on normal builds.
