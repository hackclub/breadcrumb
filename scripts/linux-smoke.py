"""Synthetic X11 capture and packaged Tauri/Go IPC smoke test (CI only)."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parent.parent
wm = subprocess.Popen(['openbox'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(40):
    ready = subprocess.run(['xprop', '-root', '_NET_SUPPORTING_WM_CHECK'], capture_output=True, text=True)
    if 'window id #' in ready.stdout:
        break
    time.sleep(.25)
window = subprocess.Popen(['xterm', '-fa', 'DejaVu Sans Mono', '-fs', '12', '-title',
                           'Synthetic native capture fixture', '-e', 'sleep', '90'])
subprocess.run(['xdotool', 'search', '--sync', '--onlyvisible', '--name',
                'Synthetic native capture fixture', 'windowactivate', '--sync'], timeout=20, check=True)
helper = subprocess.Popen([str(root / 'native/capture/target/release/breadcrumb-capture')],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
try:
    def request(command, strict=True):
        helper.stdin.write(json.dumps({'command': command, 'settings': {'maximumWidth': 1920, 'jpegQuality': .65}, 'exclusions': []}) + '\n')
        helper.stdin.flush()
        result = json.loads(helper.stdout.readline())
        if strict:
            assert result['ok'], result.get('error')
        return result
    for _ in range(20):
        probe = request('probe', strict=False)
        if probe.get('ok') and probe.get('contextKey'):
            break
        time.sleep(.25)
    assert probe.get('ok') and probe.get('contextKey'), 'No foreground X11 test window: ' + str(probe.get('error'))
    capture = request('capture')
    jpeg = base64.b64decode(capture['payload']['jpeg'], validate=True)
    assert jpeg.startswith(b'\xff\xd8') and len(jpeg) > 1000
    assert capture['record']['captureScope'] == 'display'
    assert capture['record']['visibleWindows']
    assert 'treeStatus' in capture['record']
    print('Native X11 display capture, window context, and filtered tree status passed.')
    with tempfile.TemporaryDirectory() as folder:
        output = Path(folder) / 'ipc.json'
        subprocess.run([str(root/'desktop/src-tauri/target/release/breadcrumb-desktop'), '--demo', '--smoke-test'],
            env={**os.environ, 'BREADCRUMB_SMOKE_OUTPUT':str(output),
                 'WEBKIT_DISABLE_COMPOSITING_MODE':'1', 'LIBGL_ALWAYS_SOFTWARE':'1'}, timeout=30, check=True)
        state=json.loads(output.read_text())
        assert state['demo'] and not state['recording'] and len(state['observations']) == 12
        print('Native Tauri → Go sidecar IPC passed.')
finally:
    helper.stdin.close()
    helper.terminate()
    window.terminate()
    wm.terminate()
