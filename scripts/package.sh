#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/build.sh"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$ROOT/build/Breadcrumb.app" "$STAGE/Breadcrumb.app"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/Resources/Install.txt" "$STAGE/Read Me First.txt"
ARCH="$(uname -m)"
IMAGE="$ROOT/build/Breadcrumb-macOS-$ARCH.dmg"
hdiutil create -volname Breadcrumb -srcfolder "$STAGE" -format UDZO -ov "$IMAGE"
echo "Packaged $IMAGE (not notarized)"
