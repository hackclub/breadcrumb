#!/usr/bin/env python3
"""Verify AppImage OCR and PipeWire dependencies without using host Gst plugins."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
images = list((root / 'desktop/src-tauri/target/release/bundle/appimage').glob('*.AppImage'))
assert len(images) == 1, 'Expected one native AppImage'
with tempfile.TemporaryDirectory(prefix='breadcrumb-package-') as folder:
    temp = Path(folder)
    image = images[0]
    image.chmod(image.stat().st_mode | 0o100)
    subprocess.run([str(image), '--appimage-extract'], cwd=temp, stdout=subprocess.DEVNULL, check=True, timeout=90)
    appdir = temp / 'squashfs-root'
    helpers = list(appdir.rglob('breadcrumb-capture'))
    assert len(helpers) == 1, 'Native capture helper not bundled'
    assert list(appdir.rglob('libtesseract.so*')), 'OCR library not bundled'
    plugins = list(appdir.rglob('libgstpipewire.so'))
    assert plugins, 'PipeWire GStreamer plugin not bundled'
    libdirs = sorted({str(p.parent) for p in appdir.rglob('*.so*') if p.is_file()})
    plugin_dirs = sorted({str(p.parent) for p in appdir.rglob('libgst*.so') if p.is_file()})
    result = subprocess.run([str(helpers[0])], input='{"command":"diagnostics"}\n',
        env={**os.environ, 'APPDIR': str(appdir), 'LD_LIBRARY_PATH': ':'.join(libdirs),
            'GST_PLUGIN_SYSTEM_PATH_1_0': ':'.join(plugin_dirs), 'GST_PLUGIN_PATH_1_0': '',
            'GST_REGISTRY_1_0': str(temp / 'gst-registry.bin')}, text=True, capture_output=True, timeout=30, check=True)
    response = json.loads(result.stdout)
    assert response['ok'] and all(response['dependencies'].values()), response
    print('AppImage capture helper, embedded OCR data, OCR library and isolated PipeWire plugins passed.')
