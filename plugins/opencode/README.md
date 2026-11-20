# OpenCode usage plugin

This opt-in exporter reads completed OpenCode v2 assistant usage from its local
SQLite database and appends Breadcrumb's normalized JSONL format. It requires
Python 3.11 or later with `sqlite3.Connection.blobopen`, with no extra packages.
It does not start automatically or change OpenCode's database.

1. Choose an output beneath your Breadcrumb library:
   `agent-imports/opencode/usage.jsonl`.
2. Run the exporter with `--output` and `--initialize`. This creates the provider
   directory without reading OpenCode. Enable **OpenCode (plugin)** in Breadcrumb
   Settings → Coding agents. Each plugin directory has an independent toggle.
3. Start the same command with `--watch` instead of `--initialize` to explicitly
   enable usage extraction every 30 seconds. Without `--watch`, it runs once.
   Stop the exporter to stop reading OpenCode; disable its Breadcrumb toggle to
   stop importing its output. Uploading remains a separate desktop opt-in.

```sh
python3 plugins/opencode/export.py --output "$BREADCRUMB_LIBRARY/agent-imports/opencode/usage.jsonl" --initialize
python3 plugins/opencode/export.py --output "$BREADCRUMB_LIBRARY/agent-imports/opencode/usage.jsonl" --watch
```

Set `BREADCRUMB_LIBRARY` to your existing library directory first. The default
source is `opencode/opencode.db` beneath `XDG_DATA_HOME`, or `.local/share` beneath
the operating system home directory. Override it with `--database`. On Windows,
use your installed Python 3.11+ executable and quote the full output path.

The exporter opens SQLite read-only, selects only message/session identifiers,
timestamps and working-directory metadata, and streams each assistant JSON blob
in 4 KiB chunks. It decodes only `model.id`, completion time and token counters.
Chat strings, tools, parts, instructions, files and credentials are never decoded
or exported. A local sidecar stores hashed message IDs and a cursor. Append and
cursor ordering makes crash retries safe; Breadcrumb also deduplicates response IDs.

OpenCode input is already uncached. Its reasoning and output fields are separate,
so the exporter adds reasoning to Breadcrumb's output field exactly once.
Inherited fork messages are excluded using their original creation time. Records
without a completed assistant message, valid model ID or valid token counters are
skipped. OpenCode's session totals can include auxiliary usage that has no completed
assistant record; those totals may be higher than the dated usage available to this
exporter. It does not invent timestamps or models for the difference.

Free-model names are preserved. They remain **Unpriced** unless Breadcrumb's
versioned price table has an official rate for that exact model; a name or a
provider-reported zero cost does not establish a public API rate.

Supported source schema: `session_v2` and `session_message` from OpenCode v2.
Older JSON storage and earlier SQLite schemas are unsupported by this adapter.
[OpenCode's schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts)
and [token accounting](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/token-usage.ts)
provide the field definitions. This adapter is implemented independently.

Run synthetic tests with:

```sh
python3 -m unittest discover -s plugins/opencode -p 'test_*.py'
```
