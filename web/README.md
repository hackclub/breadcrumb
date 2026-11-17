# Breadcrumb web and sync service

A small Next.js portal: email sign-in, browser approval for the desktop app, and a dashboard of synced capture time. Better Auth owns email verification, browser sessions, OAuth authorization, consent, access tokens, refresh rotation, and revocation. PostgreSQL holds its tables in the isolated `breadcrumb_auth` schema. R2 holds captures, accessibility trees, review jobs, and lightweight daily sync summaries.

There is no Hack Club identity or internal service dependency. Use any domain, your own PostgreSQL server, R2 bucket, and Loops account. Vercel is optional; the same application runs with `bun run build` and `bun run start`. The desktop accepts your portal's URL.

## Configure and run

Copy `.env.example` to `.env.local` here. Set `PUBLIC_URL`, `DATABASE_URL`, a random `BETTER_AUTH_SECRET` of at least 32 characters, R2 credentials, and your Loops API key and transactional template ID. The Loops template must accept `loginUrl`. `ALLOWED_EMAILS` is an optional comma-separated invitation list; an empty value permits any verified email address.

From the repository root:

```sh
bun install
bun install --cwd web
bun run --cwd web auth:migrate
bun run build:web
bun run --cwd web start
```

Run migrations with the same database configuration before deploying an auth schema change. They create or update only Better Auth's `breadcrumb_auth` schema. Do not use a local SQLite file for a serverless deployment.

For Vercel, set the project root to `web`, install with `bun install --frozen-lockfile`, and build with `bun run build`. Configure the same environment variables and deploy with `vc deploy --prod` under your own account or team. A self-hosted Node deployment uses the same environment and build/start commands.

## Desktop connection

In desktop Settings → Account, enter the portal URL and click Sign in. The app registers a public native OAuth client with Better Auth, opens its authorization page in the browser, and uses PKCE with an ephemeral IPv4 loopback callback. The approval page explicitly authorizes syncing **all existing and future captures**, including screenshots, text, window context, and accessibility trees for AI review. No client secret is embedded in the app.

After approval, the app reopens and syncs in the background without blocking capture. Access tokens last five minutes and are refreshed with Better Auth's rotating refresh tokens. Credentials are stored in a private per-user connection file. Signing out in the app cancels uploads and revokes the refresh token while local recording continues.

The durable queue is scoped to server and account. It pins payload files with hard links where available, uses immutable metadata snapshots for retries, and resumes after restart or network loss. Expiration of local rolling history does not discard queued work. Confirmed deletion of the last hour discards that hour's pending queue and pauses both recording and sync; captures already accepted by the server remain in the corpus.

## Data and APIs

- `/api/auth/*` is Better Auth's handler. Its OAuth provider exposes authorization, dynamic public-client registration, token, and revocation endpoints.
- `GET /.well-known/oauth-authorization-server/api/auth` provides the provider's standard metadata.
- `GET /v1/account/summary` uses a Better Auth browser session and returns paginated daily synced capture counts, estimated seconds, and last-sync timestamps.
- `POST /v1/account/index` incrementally indexes older corpus contributions into lightweight summaries. New uploads update summaries directly with R2 conditional writes, so concurrent uploads and retries do not inflate totals.
- `POST /v1/ingest` accepts `{schemaVersion:1,consent:true,record,payload}` with a Better Auth access token scoped to `captures:sync` and this server's `/v1` resource. Captures retain idempotent UUIDs; changed data under an existing UUID returns 409.
- Captures over 4 MiB use `/v1/uploads/start`, `/chunk?index=N`, and `/complete`, keeping requests below serverless body limits. Uploads are scoped to the authenticated contributor. Payloads are limited to 12 MiB with an 8 MiB decoded JPEG ceiling.
- Review-agent credentials configured in `REVIEW_AGENT_TOKENS` authorize `/v1/review/claim`, `/submit`, `/index`, and `/context/:job`. These service credentials are separate from user sign-in. Claims are leased, and reviews retain evidence and provenance.
- `GET /healthz` reports configuration. The optional `/api/cron/review` endpoint requires `CRON_SECRET` and can be invoked by any scheduler. Gateway review is disabled unless explicitly enabled and configured.

Synced time estimates merge overlapping sample windows, cap uncertain coverage at five minutes per capture, and exclude long gaps. They describe sampled desktop history, not verified work or attention. Days use UTC. The dashboard never downloads screenshots to calculate totals.

Keep R2 public access disabled. Expire temporary `incoming/` upload chunks after one day. Corpus retention is independent of local retention. Capture ownership continues using the hash of the verified email address, preserving access to existing contributions after the Better Auth migration. Old bespoke sign-in cookies and upload tokens are no longer accepted; users must sign in again.

## Validation

`bun run test:web` covers Better Auth email/session behavior, native consent, PKCE, replay rejection, refresh rotation, capture scoping, chunked uploads, concurrent sync summaries, and agent leases. `go test -race ./...` in `engine/` covers the native queue, restart and retention recovery, nonblocking upload, callback binding, refresh persistence, and sign-out cancellation.

After installing root/web dependencies, building the web app, and installing Playwright Chromium, `bun run test:sync` runs the browser and real Go engine against a temporary synthetic library and Better Auth's official memory adapter. It tests email-link sign-in, consent, PKCE callback, chunked backlog upload, refresh after restart, new-capture upload, sign-out, and mobile layout. It never opens a real capture library or sends a real sign-in email. Screenshots go to `test-results/sync/`.

`SMOKE_URL=https://your-server.example bun web/scripts/live-smoke.ts` checks live health, OAuth discovery, and unauthenticated API rejection without uploading data or sending emails.
