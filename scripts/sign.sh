#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?Usage: sign.sh /path/to/Breadcrumb.app}"
CONFIG="$ROOT/.breadcrumb-signing-identity"
IDENTITY="${BREADCRUMB_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" && -f "$CONFIG" ]]; then
  IDENTITY="$(cat "$CONFIG")"
fi
if [[ -z "$IDENTITY" ]]; then
  IDENTITIES="$(security find-identity -v -p codesigning | sed -nE '/"Developer ID Application:/s/^[[:space:]]*[0-9]+\) ([A-F0-9]{40}) .*/\1/p')"
  COUNT="$(printf '%s\n' "$IDENTITIES" | awk 'NF {n++} END {print n+0}')"
  if [[ "$COUNT" != 1 ]]; then
    echo "Choose a stable signing certificate with BREADCRUMB_SIGN_IDENTITY (found $COUNT Developer ID identities)." >&2
    echo "For a disposable preview only, explicitly set BREADCRUMB_SIGN_IDENTITY=-. Ad-hoc builds lose permissions after changes." >&2
    exit 1
  fi
  IDENTITY="$IDENTITIES"
  printf '%s\n' "$IDENTITY" > "$CONFIG"
fi
if [[ "$IDENTITY" == - ]]; then
  echo "Warning: ad-hoc preview build; permissions may need granting again after every rebuild." >&2
  codesign --force --sign - "$APP"
else
  # Never fall back to ad-hoc when a certificate/key is unavailable.
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
fi
codesign --verify --deep --strict "$APP"
codesign -d -r- "$APP"
