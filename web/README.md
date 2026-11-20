# Breadcrumb web and sync service

A small Next.js portal: email sign-in, browser approval for the desktop app, and a time dashboard with daily trends, app/activity rankings, detected projects, and hourly patterns. Better Auth owns email verification, browser sessions, OAuth authorization, consent, access tokens, refresh rotation, and revocation. PostgreSQL holds its tables in the isolated `breadcrumb_auth` schema. R2 holds captures, accessibility trees and review jobs. Dashboard activity can use R2, PostgreSQL or ClickHouse.

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
- `GET /v1/account/summary` uses a Better Auth browser session and returns paginated daily synced capture counts, estimated seconds, app/activity/project breakdowns, hourly UTC coverage, and last-sync timestamps.
- `POST /v1/account/index` incrementally indexes older corpus contributions into lightweight summaries. New uploads update summaries directly with R2 conditional writes, so concurrent uploads and retries do not inflate totals.
- `POST /v1/ingest` accepts `{schemaVersion:1,consent:true,record,payload}` with a Better Auth access token scoped to `captures:sync` and this server's `/v1` resource. Captures retain idempotent UUIDs; changed data under an existing UUID returns 409.
- Captures over 4 MiB use `/v1/uploads/start`, `/chunk?index=N`, and `/complete`, keeping requests below serverless body limits. Uploads are scoped to the authenticated contributor. Payloads are limited to 12 MiB with an 8 MiB decoded JPEG ceiling. JPEGs are stored once per account at `images/<participant>/<sha256>.jpg`; captures retain `jpegRef`. Clients can send only that reference once its pixels exist. Missing references return 409 and the desktop retries with pixels. Legacy inline uploads remain accepted.
- Review-agent credentials configured in `REVIEW_AGENT_TOKENS` authorize `/v1/review/claim`, `/submit`, `/index`, and `/context/:job`. These service credentials are separate from user sign-in. Claims are leased, and reviews retain evidence and provenance.
- `GET /healthz` reports configuration. The optional `/api/cron/review` endpoint requires `CRON_SECRET` and can be invoked by any scheduler. Gateway review is disabled unless explicitly enabled and configured.

Synced time estimates merge overlapping sample windows, cap uncertain coverage at five minutes per capture, and exclude long gaps. They describe sampled desktop history, not verified work or attention. Storage partitions use UTC; the dashboard groups days and hours in the viewer’s local timezone. The dashboard never downloads screenshots to calculate totals.

Keep R2 public access disabled. Expire temporary `incoming/` upload chunks after one day. Corpus retention is independent of local retention. Capture ownership continues using the hash of the verified email address, preserving access to existing contributions after the Better Auth migration. Old bespoke sign-in cookies and upload tokens are no longer accepted; users must sign in again.

## Validation

`bun run test:web` covers Better Auth email/session behavior, native consent, PKCE, replay rejection, refresh rotation, capture scoping, chunked uploads, concurrent sync summaries, and agent leases. `go test -race ./...` in `engine/` covers the native queue, restart and retention recovery, nonblocking upload, callback binding, refresh persistence, and sign-out cancellation.

After installing root/web dependencies, building the web app, and installing Playwright Chromium, `bun run test:sync` runs the browser and real Go engine against a temporary synthetic library and Better Auth's official memory adapter. It tests email-link sign-in, consent, PKCE callback, chunked backlog upload, refresh after restart, new-capture upload, sign-out, and mobile layout. It never opens a real capture library or sends a real sign-in email. Screenshots go to `test-results/sync/`.

`SMOKE_URL=https://your-server.example bun web/scripts/live-smoke.ts` checks live health, OAuth discovery, and unauthenticated API rejection without uploading data or sending emails.

## App icon catalog

`breadcrumb_catalog.apps` in PostgreSQL stores canonical app IDs, names, aliases (bundle IDs, package/executable names), icon paths, and official project links. `GET /api/apps` serves the shared catalog with a CDN cache. Icons are small, locally served PNGs; no browsing history is sent to external icon services. Unknown apps retain a monogram fallback.

To add or update an app, add its 64px PNG in `public/app-icons/`, edit `lib/app-seed.json`, then run `bun run apps:seed` from `web/` with `DATABASE_URL` configured. The script creates only its own catalog schema and upserts entries. Bundled entries keep the UI working before seeding or during database outages.

The dashboard's day-by-hour grid shows up to 14 recent days. Selecting an hour reveals sampled time, capture count, apps, activity, and detected projects. Local hour/day boundaries include daylight-saving changes and fractional timezones; repeated hours combine without counting time twice. Existing captures gain richer breakdowns through the incremental account index.

Dashboard app totals merge legacy names and bundle/package aliases through the canonical catalog. Activity categories use semantic SVG icons. Signed-in loading renders the same reserved dashboard frames as loaded data; the browser regression test delays authentication, catalog, summaries, and indexing updates and checks zero layout shift at desktop and mobile widths.

Activity rows open daily, app, and project breakdowns. Labels and metadata rules live in `lib/activities.ts`; explicit corrections and agent labels take precedence. The rules use focused window/app/domain metadata, and keep ambiguous browsing, terminals, and videos broad. No extra raw titles or screenshot downloads are needed for these summaries. The incremental account index upgrades older captures automatically.

Observed time describes sampled coverage, while history span is the first-to-last capture in the selected range. The dashboard shows unsampled gaps separately rather than filling sleep, pauses, or exclusions with invented activity. The desktop overview shows capture age and observed time instead of repeating capture counts.

## Analytics storage

Choose `ANALYTICS_BACKEND=r2`, `postgres`, or `clickhouse`. R2 is the default. PostgreSQL and ClickHouse store the capture activity index used by the dashboard; screenshots, trees and capture bundles stay in R2. Better Auth, profiles and the app catalog continue using PostgreSQL.

For PostgreSQL analytics, set `ANALYTICS_DATABASE_URL` or reuse `DATABASE_URL`. For ClickHouse, set `CLICKHOUSE_URL` to its HTTP(S) endpoint, plus `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` and `CLICKHOUSE_DATABASE` (default `breadcrumb`). Keep these settings server-side.

With the chosen backend configured, prepare its schema and replay existing captures before switching the running app:

```sh
bun run analytics:migrate
bun run analytics:backfill
```

Backfill is idempotent and prints a continuation cursor after each batch. Resume an interrupted run with `bun run analytics:backfill --cursor '…'`. Change `ANALYTICS_INDEX_VERSION` when switching destinations or returning to an earlier backend so incremental account indexing rechecks its history.

All backends use the same time accounting, including overlaps, gaps and local day boundaries. ClickHouse reads deduplicate retries before summaries are calculated, and inserts wait for persistence before an upload is acknowledged. A database outage leaves the capture in R2 and returns an error so the desktop can retry safely.

`bun run test:analytics` checks real PostgreSQL and ClickHouse instances using synthetic data. It requires explicit `ANALYTICS_TEST_POSTGRES_URL` and `ANALYTICS_TEST_CLICKHOUSE_URL` pointing to disposable local databases, with optional `ANALYTICS_TEST_CLICKHOUSE_USER` and `ANALYTICS_TEST_CLICKHOUSE_PASSWORD`. The PostgreSQL test database must be named `breadcrumb_analytics_test`. CI runs the same parity checks.
