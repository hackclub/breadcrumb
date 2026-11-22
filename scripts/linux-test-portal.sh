#!/usr/bin/env bash
# Build a portal fixture for software-only headless capture. Never bundle it.
set -euo pipefail
folder="${1:?Usage: linux-test-portal.sh OUTPUT_DIRECTORY}"
git init -q "$folder"
git -C "$folder" fetch -q --depth 1 https://github.com/emersion/xdg-desktop-portal-wlr.git 74428f2a8fa7f252e2a46fdf5b697536c66c8a1c # v0.7.1
git -C "$folder" checkout -q --detach FETCH_HEAD
python3 - "$folder" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1]) / 'src/screencast/screencast.c'
source = path.read_text()
# xdpw 0.7 rejects a valid SHM format when Pixman supplies no DMA-BUF format.
# Let this test backend negotiate its existing SHM path. Production uses the
# user's desktop portal without modification.
old = ''' ||
			(cast->ctx->state->screencast_version >= 3 &&
			 cast->screencopy_frame_info[DMABUF].format == DRM_FORMAT_INVALID)'''
assert old in source, 'Portal fixture no longer matches pinned source'
path.write_text(source.replace(old, ''))
PY
meson setup "$folder/build" "$folder" -Dman-pages=disabled -Dsd-bus-provider=libsystemd
ninja -C "$folder/build"
