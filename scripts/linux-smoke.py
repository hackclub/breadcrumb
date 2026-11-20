"""Synthetic X11 capture and packaged Tauri/Go IPC smoke test (CI only)."""
import base64
import json
import os
import select
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
fixture = None
try:
    def request(command, strict=True, exclusions=None):
        helper.stdin.write(json.dumps({'command': command, 'settings': {'maximumWidth': 1920, 'jpegQuality': .65}, 'exclusions': exclusions or []}) + '\n')
        helper.stdin.flush()
        assert select.select([helper.stdout], [], [], 15)[0], 'Native helper timed out'
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
    assert capture['capabilities']['idle'] and 0 <= capture['idleSeconds'] < 3600, 'X11 idle time unavailable'
    print('Native X11 display capture, window context, and filtered tree status passed.')
    fixture = subprocess.Popen(['/usr/bin/python3', str(root/'scripts/linux-tree-fixture.py')],
        env={**os.environ, 'NO_AT_BRIDGE':'0', 'GTK_MODULES':'gail:atk-bridge'})
    subprocess.run(['xdotool','search','--sync','--onlyvisible','--name','^Synthetic GTK fixture$',
                    'windowactivate','--sync'],timeout=20,check=True)
    # Let GTK register its accessible objects before the first tree query.
    for _ in range(20):
        captured = request('capture')
        tree = json.dumps(captured['payload']['tree'])
        if 'PUBLIC_LABEL_SENTINEL' in tree:
            break
        time.sleep(.25)
    assert 'PUBLIC_LABEL_SENTINEL' in tree and 'PUBLIC_BUTTON_SENTINEL' in tree, 'Synthetic public labels missing'
    assert all(secret not in tree for secret in ['EDITABLE_VALUE_SENTINEL','PASSWORD_VALUE_SENTINEL','COMBO_EDITABLE_SENTINEL']), 'Editable accessibility data leaked'
    assert captured['contextKey'] != probe['contextKey'], 'Focus change not reflected'
    app = captured['record']['app']
    excluded = request('capture',exclusions=[app.upper()])
    assert not excluded.get('contextKey') and 'payload' not in excluded
    subprocess.run(['xdotool','search','--onlyvisible','--name','^Synthetic native capture fixture$',
                    'windowactivate','--sync'],timeout=10,check=True)
    excluded = request('capture',strict=False,exclusions=[app.upper()])
    assert not excluded['ok'] and 'excluded' in excluded['error'] and 'payload' not in excluded
    print('Focus changes, filtered editable/password/combo-box data, and visible-window exclusions passed.')
    for overrides in [{'WAYLAND_DISPLAY':'synthetic-wayland'}, {'XDG_SESSION_TYPE':'wayland'}, {'DISPLAY':''}]:
        result = subprocess.run([str(root/'native/capture/target/release/breadcrumb-capture')],
            input='{"command":"capture"}\n',text=True,capture_output=True,timeout=15,
            env={**os.environ,'WAYLAND_DISPLAY':'','XDG_SESSION_TYPE':'x11',**overrides})
        response = json.loads(result.stdout)
        assert not response['ok'] and 'payload' not in response and not response['capabilities']['screenshot']
    print('Wayland/XWayland and headless sessions fail closed.')
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
    if fixture:
        fixture.terminate()
    window.terminate()
    wm.terminate()
