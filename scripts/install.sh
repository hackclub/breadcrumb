#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/desktop-build.sh"
PARENT="$HOME/Applications"
if [[ ! -d "$PARENT/Breadcrumb.app" && -d /Applications/Breadcrumb.app ]]; then
  PARENT=/Applications
elif [[ ! -d "$PARENT/Breadcrumb.app" && ! -d "$PARENT/Rewind.app" && -d /Applications/Rewind.app ]]; then
  PARENT=/Applications
fi
TARGET="$PARENT/Breadcrumb.app"
PREVIOUS="$TARGET"
if [[ ! -d "$PREVIOUS" && -d "$PARENT/Rewind.app" ]]; then PREVIOUS="$PARENT/Rewind.app"; fi
SOURCE="$ROOT/desktop/src-tauri/target/release/bundle/macos/Breadcrumb.app"
SOURCE_DETAILS="$(codesign -dv "$SOURCE" 2>&1)"
if [[ "$SOURCE_DETAILS" == *Signature=adhoc* ]]; then
  echo "Refusing to install an ad-hoc build. Configure BREADCRUMB_SIGN_IDENTITY first." >&2
  exit 1
fi
REQUIREMENT="$(codesign -d -r- "$SOURCE" 2>&1 | sed -n 's/^designated => //p')"
if [[ -z "$REQUIREMENT" ]]; then echo "No designated requirement found" >&2; exit 1; fi
if [[ -d "$PREVIOUS" ]]; then
  OLD_REQUIREMENT="$(codesign -d -r- "$PREVIOUS" 2>&1 | sed -n 's/^designated => //p')"
  if [[ "$OLD_REQUIREMENT" != "$REQUIREMENT" ]]; then
    DETAILS="$(codesign -dv "$PREVIOUS" 2>&1)"
    if [[ "$DETAILS" != *Signature=adhoc* ]]; then
      echo "Installed app uses a different signing requirement; refusing replacement." >&2
      exit 1
    fi
    echo "Switching from ad-hoc signing may require one final permission grant."
  fi
  # This identifier deliberately survives the product rename to preserve TCC/preferences.
  osascript -e 'tell application id "app.rewind.local" to quit'
  for ((attempt=0; attempt<50; attempt++)); do
    if ! pgrep -f "$PREVIOUS/Contents/MacOS/" >/dev/null; then break; fi
    sleep 0.1
  done
  if pgrep -f "$PREVIOUS/Contents/MacOS/" >/dev/null; then echo "Breadcrumb is still running; stopped." >&2; exit 1; fi
fi
mkdir -p "$PARENT"
STAGE="$(mktemp -d "$PARENT/.breadcrumb-install.XXXXXX")"
ditto "$SOURCE" "$STAGE/Breadcrumb.app"
codesign --verify --deep --strict -R="$REQUIREMENT" "$STAGE/Breadcrumb.app"
BACKUP="$(mktemp -d -t breadcrumb-previous)"
if [[ -d "$PREVIOUS" ]]; then mv "$PREVIOUS" "$BACKUP/previous.app"; fi
if ! mv "$STAGE/Breadcrumb.app" "$TARGET"; then
  if [[ -d "$BACKUP/previous.app" ]]; then mv "$BACKUP/previous.app" "$PREVIOUS"; fi
  exit 1
fi
rmdir "$STAGE"
codesign --verify --deep --strict -R="$REQUIREMENT" "$TARGET"
open "$TARGET"
echo "Installed and reopened $TARGET; previous app: $BACKUP/previous.app"
