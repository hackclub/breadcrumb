# Coding-agent usage

Coding-agent usage is optional and disabled by default. Enable Claude Code, Codex,
Grok Build, OpenCode, Antigravity or usage plugins individually in desktop
Settings → Coding agents. Open the local
dashboard and select Coding agents for Cost and Tokens, past 24 hours or 7/30/90
days, daily trends, session counts, model/day breakdowns and cache savings.

The reader extracts only usage numbers, timestamps, model and session identifiers,
parent identifiers and project identity. It discards message text, tool calls,
responses, instructions and file contents without decoding their string values.
Usage is stored separately from capture history in a local database. Turning a
provider off stops further reads; previously collected statistics remain local.
Capture sync does not upload this database. Token usage uploads are a separate opt-in; chats are never uploaded by that feature.

## Providers and discovery

- Claude Code: `CLAUDE_CONFIG_DIR` (default `~/.claude`), beneath `projects`,
  including subagent JSONL files. Responses are deduplicated by message ID and
  request ID (message ID alone when older records omit the request ID).
- Codex: `CODEX_HOME` (default `~/.codex`), beneath `sessions`. Per-response
  `token_usage_record` data replaces legacy `token_count` estimates for a session.
  Response IDs are deduplicated across rollouts. Legacy cumulative totals reject
  repeats. Inherited legacy events before a fork's creation time are excluded;
  legacy forks without a creation timestamp are excluded conservatively.
- Grok Build: `GROK_HOME` (default `~/.grok`), beneath `sessions`, reading only
  each session's `updates.jsonl`. Each `turn_completed` record reports usage per
  model; turns without one are not counted. Routed model IDs such as
  `inception/mercury-2.5` keep the part after the last slash.
- OpenCode v2: `OPENCODE_DATA_DIR` (default `$XDG_DATA_HOME/opencode`, then
  `~/.local/share/opencode`), reading `opencode.db` read-only. Only completed
  assistant responses count. Forks skip the earlier responses they copy. Message
  data stays inside SQLite; only the model ID, completion time and token counts are
  selected. The earlier [usage exporter](../plugins/opencode/README.md) uses the same
  response IDs, so enabling both counts each response once.
- Antigravity: `ANTIGRAVITY_DATA_DIR` (a list of directories), otherwise
  `~/.gemini/antigravity-cli`, `~/.gemini/antigravity`, `~/.gemini/antigravity-ide`
  and `~/.config/antigravity`, reading each `conversations/*.db` read-only. Usage
  comes from the protobuf metadata saved with each generation and step, never from
  step contents. Records that share a response ID count once. A model code
  without a saved name takes the name the same conversation saved with that code.
- JSONL plugins: `agent-imports` beneath Breadcrumb's library directory. Each
  immediate provider subdirectory registers a separate, initially disabled toggle.
  The generic importer reads only files directly in `agent-imports`.

SQLite stores are re-read when the database or its write-ahead log changes.

Home discovery uses the operating system home directory, including Windows user
profiles. Windows working-directory separators are recognized. Project names use
the nearest git root directory when available; no project path is returned in
usage results. Provider roots and cursor paths remain local.

Gemini CLI, Cursor and Copilot do not yet have native Breadcrumb readers. An adapter can export the format below without a Go change.
No estimates are inferred from conversation text. Logs outside the documented
roots and missing usage records cannot contribute statistics.

## Plugin contract, version 1

Write UTF-8 JSONL files ending in `.jsonl` in `agent-imports/<provider-id>` for
an independently enabled plugin, or directly in `agent-imports` for the generic
importer. Subdirectory names use letters, digits, dots, underscores and hyphens.
The record's provider must match its directory. Append one normalized
event per line, followed by a newline. Files are watched only while their own provider toggle is enabled. Use a unique provider ID for each harness; `claude` and `codex` are
reserved. Repeated `(provider, id)` pairs count only once, even across files.

```json
{
  "provider": "example-cli",
  "id": "response-001",
  "session": "session-001",
  "model": "example-model",
  "time": "2026-11-20T14:00:00Z",
  "project": "example-project",
  "input": 1000,
  "cacheRead": 2000,
  "cacheWrite": 300,
  "cacheWrite1h": 100,
  "output": 400,
  "reasoning": 200
}
```

Required: `provider`, `id`, `session`, `model`, `time`. Optional: `parent`,
`project` and all token fields (default zero). No other fields are accepted,
including nested objects, arrays or chat fields. Strings have bounded lengths.
Provider, model and session identifiers use letters, digits, `.`, `_`, `:`, `@`,
`+` and `-`. Project names may include spaces and Unicode but must be a single
component without slashes, backslashes, colons or control characters. They must
not be paths or usernames. Do not use
account identities for projects. `time` must be RFC 3339 with an offset.

Token values must be nonnegative JSON integers, at most one trillion per event:

- `input`: **uncached** input, excluding reads and writes.
- `cacheRead`: input retrieved from cache.
- `cacheWrite`: newly cached input, including the one-hour subset.
- `cacheWrite1h`: the one-hour subset of cache writes; other writes use the 5m rate.
- `output`: all output, **including** reasoning.
- `reasoning`: subset of output, never added to processed tokens or charged twice.

`cacheWrite1h <= cacheWrite` and `reasoning <= output`. Malformed records are
skipped; incomplete final lines wait for their newline. Records larger than
16 MiB are skipped with bounded memory. Supply compact usage-only events for
harnesses that emit larger records. Symlink entries are ignored. Readers persist
file identity, size, modification time and offsets; truncation and replacement
restart that file without counting previously imported response IDs twice.

The Go `Provider` interface defines ID, display name, root discovery and incremental
record parsing with persistent session context; one record can yield an event per
model. Database providers read a store's allowlisted values on change instead. The generic importer is the
extension point for independent harnesses. New native readers must honor the same
privacy boundary and synthetic-fixture tests.

## Accounting and prices

Statistics use hourly UTC buckets and display days in the viewer's local time
zone, using the same calendar formatter as time insights. Range boundaries have
hourly precision. Session start/end times are retained for future build-time
accounting but do not currently add to observed time.

`web/lib/model-prices.json` is a versioned shared price table with source links
and verification dates. `bun scripts/update-model-prices.ts [--add model ...]`
refreshes it from LiteLLM's public price list, using each model's first-party API
entry. Dated snapshots such as `gpt-6.1-sol-2026-09-29` use their model's price,
and OpenCode's `-free` models cost nothing. Grok Build models use the rates Grok
Build reports per turn; its fast variants cost twice as much. Estimates use
standard API rates and are labeled **API estimate**. They are not subscription
bills. Unknown models remain **Unpriced**:
their tokens still count, but their cost does not enter shares. Cache savings are
cache reads priced as uncached input minus the actual cache-read estimate.
Long-context surcharges, premium speed tiers and negotiated discounts are not
included. The table is applied when displaying usage, not during ingestion.

Official references: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[GPT-5.4 pricing](https://developers.openai.com/api/docs/models/gpt-5.4),
and [GPT-5.1-Codex pricing](https://developers.openai.com/api/docs/models/gpt-5.1-codex).

[T3 Code usage documentation](https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md)
was consulted for comparison, and its usage readers for the Grok Build, OpenCode
and Antigravity storage layouts, including Antigravity's metadata field numbers
and older model codes. Its [MIT license](https://github.com/pingdotgg/t3code/blob/main/LICENSE)
permits reuse; Breadcrumb's readers are written separately in Go.

## Optional private uploads

Desktop sign-in asks for both `captures:sync` and `agents:sync`, so each device
keeps one connection to the portal. Token usage uploads still stay off until you
turn on Settings → Coding agents → Upload to dashboard. That uploads existing and
future hourly statistics. Turn it off to pause; capture sync keeps running.
Connections made before 0.2.9 lack `agents:sync`; choose Allow to sign in again.
The app then retires any older token-usage connection from that device.
Previously uploaded statistics remain private on the server.

The upload boundary has only provider/model/project names, hourly token buckets,
event and session-start counts, a revision, and a random library identifier.
Session IDs, parent IDs, working directories and file cursors never cross it.
Project names come from a git root or repository remote; unversioned directories
are left unassigned rather than using a home-directory name.

The portal's private [Coding agents view](/agents) uses the same presentation and
price table as the local dashboard. Portal sessions count **starts**, avoiding
sending session identifiers. `GET /api/v1/agents/usage` requires `agents:read`;
MCP exposes `breadcrumb_get_agent_usage` only with that scope. Agent statistics
are excluded from public profiles, leaderboards and build-time accounting.

Upload clients POST to `/v1/agents/ingest` using a token scoped to `agents:sync`
and the `/v1` resource. Every request requires `consent: true`. Each source/hour
snapshot contains unique provider/model/project rows. Newer revisions replace
older snapshots, including empty replacements when earlier estimates disappear.
A stable random source ID avoids collisions across libraries without sending a
hostname or username. Retries are idempotent and stale revisions cannot overwrite
newer data. Updates are atomic per hour, not across an entire request.

R2, PostgreSQL and ClickHouse support identical usage semantics. When using SQL
analytics, run `bun run --cwd web analytics:migrate` before deploying this feature
to create `agent_hours`; ordinary builds do not migrate analytics databases.
The standalone parity check is `bun web/scripts/agents-smoke.ts` with disposable
local database URLs using the existing analytics test environment variables.
