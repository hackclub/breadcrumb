# Corpus service

Go server and embedded web UI in the same repository as the Swift macOS client and Python agent tools. Requires Go 1.24+. Cloudflare R2 stores captures and account credentials; Loops delivers sign-in emails. There is no application-layer encryption of corpus objects.

## Run

1. Create a **private** R2 bucket and a bucket-scoped S3 API key with object read/write/delete permissions. Leave public access disabled. Use the exact endpoint shown by Cloudflare (including jurisdiction prefix when applicable).
2. In Loops, publish a transactional email with a `loginUrl` data variable used as its sign-in button/link. Copy its transactional ID and an API key.
3. Copy `.env.example` to `.env`, fill it in, and invite your friends through `ALLOWED_EMAILS`.
4. From `server/`:

```sh
set -a
source .env
set +a
go run ./cmd/breadcrumb-server
```

Open `PUBLIC_URL`. For local development set `PUBLIC_URL=http://localhost:8080` and optionally `LOCAL_DATA_DIR=./data`; mail still goes through Loops. Production requires HTTPS at a reverse proxy forwarding to the Go service. Do not log request bodies, Authorization headers, cookies, or email links at the proxy. The service itself logs only startup/errors without request contents.

Docker build: `docker build -t breadcrumb-server server` from the repository root. Run with `--env-file server/.env -p 8080:8080`; keep the port behind your HTTPS proxy. R2 credentials and Loops secrets stay on the server. The service also accepts standard `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_ENDPOINT_URL_S3` variables as fallbacks for the corresponding `R2_` values; `R2_BUCKET` is still required. The region is `auto`.

## Contribution flow

Invited users enter their email. Loops sends a 15-minute one-time link. The link uses a URL fragment, removed immediately by the page, and an explicit **Finish signing in** button so an email scanner's GET does not consume it. The server creates a seven-day HttpOnly session. Signed-in users create 30-day, upload-only bearer tokens; these are displayed once, never stored in browser localStorage, and can be revoked using the token itself. Server-side credential objects contain SHA-256 token hashes, account identity, type, and expiry, never raw tokens. Email addresses are retained in private auth objects; capture objects carry a stable account ID derived from normalized email (a pseudonym, not anonymization).

The macOS recorder continues to record locally. It does not upload automatically. Friends can select one capture and prepare a bundle using the repository's agent CLI:

```sh
python3 agents/breadcrumb.py list
python3 agents/breadcrumb.py bundle CAPTURE_UUID --output /tmp/contribution.json
```

Review the bundle, then choose it on the web page, paste an upload token, check the contribution consent box, and upload. The bundle includes metadata, labels/corrections, the JPEG, and the filtered accessibility tree. Any content present in those fields is contributed. Local deletion does not remove server copies.

For agents or scripts, set `BREADCRUMB_UPLOAD_TOKEN` privately in the environment, then explicitly upload a selected capture:

```sh
python3 agents/breadcrumb.py upload CAPTURE_UUID --server https://breadcrumb.example.com --consent
```

## API

- `POST /auth/login`: `{ "email": "friend@example.com" }`; returns 202 for invited and uninvited emails. One email per minute per invited account per process.
- `POST /auth/verify`: `{ "token": "magic-link-secret" }`; consumes the link once and sets a session cookie.
- `GET /auth/me`: current session account.
- `POST /auth/token`: session required; returns `{ "token": "…", "expires": "…" }`.
- `POST /auth/logout`: invalidates the current session. Upload tokens remain valid.
- `POST /auth/revoke`: bearer token required; revokes that upload token.
- `POST /v1/ingest`: upload bearer token required, `Content-Type: application/json`.
- `GET /healthz`: process liveness; does not probe R2 or Loops.

Browser auth POSTs require an `Origin` exactly equal to `PUBLIC_URL`. Upload ingestion uses bearer authentication only, so a session cookie cannot authorize an upload. There is no CORS grant or public corpus-reading endpoint.

An ingestion request is one capture:

```json
{
  "schemaVersion": 1,
  "consent": true,
  "record": {
    "id": "12345678-1234-1234-1234-123456789abc",
    "date": 816000000,
    "app": "Example editor",
    "bundleID": "org.example.Editor",
    "windowTitle": "Example.swift"
  },
  "payload": {
    "jpeg": "",
    "tree": [{ "role": "AXWindow", "label": "Example.swift", "depth": 0 }]
  }
}
```

`record` preserves additional Breadcrumb metadata, including classifications and corrections. `date` uses Swift's seconds since 2001-01-01 UTC. `jpeg` is base64; either screenshot bytes or at least one tree node is required. Trees are accepted as supplied; the web service cannot collect a friend's desktop tree itself. The native client collects it with macOS permission. Requests are limited to 12 MiB, decoded screenshots to 8 MiB, trees to 1000 nodes, depth to 64, roles to 256 bytes, and labels to 8192 bytes. JPEG bytes are retained as submitted, without decoding or image format verification.

Successful ingestion returns 201 and `{ "id": "…", "duplicate": false }`. Repeating an identical request returns 200 with `duplicate: true`. Changed content for an existing account/capture ID returns 409. R2 conditional creation prevents overwrites across replicas. Retries after transient 503 responses are safe. IDs are scoped by the authenticated account, never by a client-supplied contributor name.

## R2 layout and operations

- `captures/<account-id>/<capture-uuid>.json`: received timestamp, account ID, content digest, consent, original metadata, screenshot, and tree. These are straightforward JSON objects for later labeling jobs.
- `auth/credentials/<token-sha256>.json`: expiring login/session/upload credentials.
- `auth/used/<token-sha256>.json`: one-time login claims, created conditionally across replicas.

Configure R2 lifecycle cleanup for `auth/` after **32 days**, longer than all credential lifetimes; expiry is enforced by the application even before cleanup. Set a separate corpus retention policy if desired. Corpus objects otherwise remain indefinitely. To withdraw a friend's contributions, remove their email from `ALLOWED_EMAILS`, restart **all** service replicas, and delete `captures/<account-id>/` using R2 tooling. Their account ID is visible in `/auth/me` and private credential objects. Removing invitations blocks existing tokens on each subsequent request; already in-flight requests may finish, so disable access before deletion.

This is a scaffold: per-account storage quotas, distributed email throttling, corpus browsing/label editing, automated withdrawal, and native background sync are not implemented. Before opening enrollment beyond invited friends, add edge rate limits for auth and ingest and storage/billing monitoring. Multiple service replicas share one-time link claims and captures through R2; the one-minute email cooldown is per process.

## Verification

```sh
go test -race ./...
go vet ./...
go build ./cmd/breadcrumb-server
```

Tests use local temporary storage and an HTTP S3 fixture. The optional `BREADCRUMB_LIVE_R2=1 go test -run TestLiveR2 -v ./...` test uses the configured R2 environment, writes synthetic objects under a unique `smoke/` prefix, verifies conditional create/read/delete, and cleans up its own object. No real email is sent and no production bucket is touched. Live R2 permissions, Loops template delivery, and the deployed HTTPS origin require configured credentials and live verification.

Provider references: [Cloudflare S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [Cloudflare conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/), [Loops transactional email guide](https://app.loops.so/docs/transactional/guide).

## AI-agent corpus review

Configure `REVIEW_AGENT_TOKENS` as a JSON object mapping trusted agent names to distinct random secrets of at least 32 characters. These are **corpus-wide read/review credentials**, separate from participant upload tokens. Leave the setting empty to disable agent access. The server stamps the agent name onto results. Revoking a token means removing it from configuration and restarting every service replica.

Each upload creates an immutable queue item. An upload retry also repairs a missing queue item if the capture was saved before queue creation failed. For older captures, the agent runner's `--index` command backfills queue entries in bounded pages.

The agent API is:

- `POST /v1/review/claim?cursor=...`: returns one capture, its screenshot/tree/OCR, an opaque job ID, lease secret, generation, expiry, and a context URL. Claims last ten minutes. If a page has no available work it returns `job: null` and `nextCursor`; continue until the cursor is empty.
- `GET /v1/review/context/<job>?cursor=...`: paginated metadata from that capture's contributor. Records include browser/editor context and visible alongside windows. These pages use UUID order; sort by capture date when finding temporal neighbors.
- `POST /v1/review/submit`: sends job, lease, generation, model, prompt version, summary, session hint, evidence-backed activity labels, and flags. Labels distinguish `focused`, `alongside`, and `uncertain`, with confidence `low`, `medium`, or `high`. The server checks lease ownership/expiry, stamps provenance, and stores the first accepted result immutably.
- `POST /v1/review/index?cursor=...`: backfills queue items for existing capture objects, twenty at a time.

Conditional R2 object creation arbitrates competing claims, including between replicas. Expired claims can be reclaimed with a new generation. Agent/model failures leave work available after expiry. Results live at `review/results/<job>.json`, queue metadata at `review/items/`, and claim history at `review/claims/`. These paths do not use the `auth/` lifecycle. Results preserve the original capture and manual correction rather than rewriting either. A review's `session` is a task/project hint; it is not evidence of elapsed working time or a durable cross-user session ID.

From the repository root, configure the following **worker** environment: `BREADCRUMB_REVIEW_TOKEN`, `AI_GATEWAY_API_KEY`, and `AI_GATEWAY_MODEL`. Choose a Vercel Gateway vision model supporting JSON output. The Gateway adapter uses `https://ai-gateway.vercel.sh/v1/chat/completions`; it submits the screenshot, capture metadata, accessibility tree, and OCR for review. It does not submit review leases, auth records, or the stored participant identifier. Capture contents themselves can still identify someone.

```sh
# Backfill old uploads (optional; new uploads enqueue automatically).
python3 agents/review.py --server https://breadcrumb.example.com --index

# Review up to ten available captures through Vercel AI Gateway.
python3 agents/review.py --server https://breadcrumb.example.com \
  --reviewer 'python3 agents/gateway_reviewer.py' --max-jobs 10
```

Run this bounded command from a scheduler or process supervisor for recurring review. It exits when there is no claimable work; failed agent runs exit and their claims expire. The runner invokes the agent without a shell, strips review credentials/lease data and unrelated environment credentials from the child, and limits each call to eight minutes. It is not a sandbox. Other trusted agent programs can implement the same JSON stdin/stdout contract described in [`agents/REVIEWING.md`](../agents/REVIEWING.md).

Agent review is configured but does not start automatically, and the Go server does not hold a model API key. The Vercel adapter has contract tests with a synthetic response. A synthetic claim/submit cycle has also passed against the configured live R2 bucket, with all temporary objects removed. A live synthetic multimodal review through `deepseek/deepseek-v4.1-flash-1017` has passed: it returned separate focused AI-conversation and alongside YouTube labels, with playback explicitly unverified. Worker credentials/model are saved in the ignored local `server/.env`; invoking a worker still requires a configured review token and a running corpus API. No personal captures were sent in that test.

Gateway reference: [Vercel Python API compatibility](https://vercel.com/docs/ai-gateway/sdks-and-apis/python).
