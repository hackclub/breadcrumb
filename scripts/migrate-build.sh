#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
swift build -c release
BIN="$(swift build -c release --show-bin-path)"
APP="$ROOT/build/Breadcrumb.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/Breadcrumb" "$APP/Contents/MacOS/Breadcrumb"
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
bash "$ROOT/scripts/sign.sh" "$APP"
echo "Built $APP (signature verified; not notarized)"
