# Coding-agent usage

Coding-agent usage is optional and disabled by default. Enable Claude Code, Codex,
or JSONL plugins individually in desktop Settings → Coding agents. Open the local
dashboard and select Coding agents for Cost and Tokens, past 24 hours or 7/30/90
days, daily trends, session counts, model/day breakdowns and cache savings.

The reader extracts only usage numbers, timestamps, model and session identifiers,
parent identifiers and project identity. It discards message text, tool calls,
responses, instructions and file contents without decoding their string values.
Usage is stored separately from capture history in a local database. Turning a
provider off stops further reads; previously collected statistics remain local.
Capture sync does not upload this database. Token-account usage uploads require a
separate opt-in in the sync phase; chats must never be uploaded by that feature.

## Providers and discovery

- Claude Code: `CLAUDE_CONFIG_DIR` (default `~/.claude`), beneath `projects`,
  including subagent JSONL files. Responses are deduplicated by message ID and
  request ID (message ID alone when older records omit the request ID).
- Codex: `CODEX_HOME` (default `~/.codex`), beneath `sessions`. Per-response
  `token_usage_record` data replaces legacy `token_count` estimates for a session.
  Response IDs are deduplicated across rollouts. Legacy cumulative totals reject
  repeats. Inherited legacy events before a fork's creation time are excluded;
  legacy forks without a creation timestamp are excluded conservatively.
- JSONL plugins: `agent-imports` beneath Breadcrumb's library directory.

Home discovery uses the operating system home directory, including Windows user
profiles. Windows working-directory separators are recognized. Project names use
the nearest git root directory when available; no project path is returned in
usage results. Provider roots and cursor paths remain local.

Grok Build, Gemini CLI, opencode, Cursor and Copilot do not yet have native
Breadcrumb readers. An adapter can export the format below without a Go change.
No estimates are inferred from conversation text. Logs outside the documented
roots and missing usage records cannot contribute statistics.

## Plugin contract, version 1

Write UTF-8 JSONL files ending in `.jsonl` in `agent-imports`. Append one normalized
event per line, followed by a newline. Files are watched only while JSONL plugins
is enabled. Use a unique provider ID for each harness; `claude` and `codex` are
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
Provider, model, session and project identifiers use letters, digits, `.`, `_`,
`:`, `@`, `+` and `-`; project names must not be paths or usernames. Do not use
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
record parsing with persistent session context. The generic importer is the
extension point for independent harnesses. New native readers must honor the same
privacy boundary and synthetic-fixture tests.

## Accounting and prices

Statistics use hourly UTC buckets and display days in the viewer's local time
zone, using the same calendar formatter as time insights. Range boundaries have
hourly precision. Session start/end times are retained for future build-time
accounting but do not currently add to observed time.

`web/lib/model-prices.json` is a versioned shared price table with source links
and verification dates. Estimates use standard API rates and are labeled **API
estimate**. They are not subscription bills. Unknown models remain **Unpriced**:
their tokens still count, but their cost does not enter shares. Cache savings are
cache reads priced as uncached input minus the actual cache-read estimate.
Long-context surcharges, premium speed tiers and negotiated discounts are not
included. The table is applied when displaying usage, not during ingestion.

Official references: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[GPT-5.4 pricing](https://developers.openai.com/api/docs/models/gpt-5.4),
and [GPT-5.1-Codex pricing](https://developers.openai.com/api/docs/models/gpt-5.1-codex).

[T3 Code usage documentation](https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md)
was consulted for comparison. Its [MIT license](https://github.com/pingdotgg/t3code/blob/main/LICENSE)
permits reuse; Breadcrumb's reader implementation is independent.
