#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" == Darwin ]]; then export MACOSX_DEPLOYMENT_TARGET=14.0; fi
python3 scripts/desktop-prepare.py
if [[ "${1:-}" == --prepare ]]; then exit 0; fi
if [[ "$(uname -s)" == Darwin && "${BREADCRUMB_SKIP_SIGNING:-0}" != 1 ]]; then
  if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    export APPLE_SIGNING_IDENTITY="$(cat "$ROOT/.breadcrumb-signing-identity")"
  fi
fi
bun run --cwd desktop build
if [[ "$(uname -s)" == Darwin ]]; then
  bun run --cwd desktop tauri build --bundles app
else
  bun run --cwd desktop tauri build
fi
