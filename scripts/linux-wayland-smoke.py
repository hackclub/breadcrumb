#!/usr/bin/env python3
"""Exercise the real ScreenCast/PipeWire path in a disposable headless Sway session.

Run under dbus-run-session as a non-root user. The picker is bypassed only by
this fixture's private portal configuration, never by the app.
"""
import base64
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parent.parent
binary = Path(os.environ.get('BREADCRUMB_CAPTURE_BINARY', root / 'native/capture/target/release/breadcrumb-capture'))
processes = []
with tempfile.TemporaryDirectory(prefix='breadcrumb-wayland-') as folder:
    temp = Path(folder)
    runtime = temp / 'runtime'
    runtime.mkdir(mode=0o700)
    config = temp / 'config'
    backend = config / 'xdg-desktop-portal-wlr'
    backend.mkdir(parents=True)
    (backend / 'config').write_text('[screencast]\nchooser_type=none\noutput_name=HEADLESS-1\n')
    (temp / 'sway.conf').write_text('output * bg #335577 solid_color\n')
    env = {**os.environ, 'XDG_RUNTIME_DIR': str(runtime), 'XDG_CONFIG_HOME': str(config),
           'XDG_SESSION_TYPE': 'wayland', 'XDG_CURRENT_DESKTOP': 'sway',
           'WLR_BACKENDS': 'headless', 'WLR_LIBINPUT_NO_DEVICES': '1', 'WLR_RENDERER': 'pixman'}
    env.pop('DISPLAY', None)
    env.pop('WAYLAND_DISPLAY', None)

    def launch(args):
        log = open(temp / (Path(args[0]).name + '.log'), 'w')
        p = subprocess.Popen(args, env=env, stdout=log, stderr=log)
        log.close()
        processes.append(p)
        return p

    try:
        launch(['sway', '-c', str(temp / 'sway.conf')])
        for _ in range(100):
            sockets = [p for p in runtime.glob('wayland-*') if p.is_socket()]
            if sockets:
                break
            time.sleep(.1)
        assert sockets, 'Headless Wayland compositor did not start'
        env['WAYLAND_DISPLAY'] = sockets[0].name
        subprocess.run(['dbus-update-activation-environment', *[f'{k}={env[k]}' for k in
            ['WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME']]], check=True)
        launch(['pipewire'])
        for _ in range(100):
            if (runtime / 'pipewire-0').is_socket():
                break
            time.sleep(.1)
        assert (runtime / 'pipewire-0').is_socket(), 'PipeWire did not start'
        launch(['wireplumber'])
        portal_backend = launch([os.environ.get('BREADCRUMB_TEST_PORTAL') or shutil.which('xdg-desktop-portal-wlr') or '/usr/libexec/xdg-desktop-portal-wlr', '-l', 'DEBUG'])
        for _ in range(100):
            owner = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.freedesktop.impl.portal.desktop.wlr'], env=env, capture_output=True, text=True, check=True)
            if 'true' in owner.stdout:
                break
            assert portal_backend.poll() is None, 'Test portal exited during startup'
            time.sleep(.1)
        assert 'true' in owner.stdout, 'Test portal did not register on D-Bus'
        launch([shutil.which('xdg-desktop-portal') or '/usr/libexec/xdg-desktop-portal'])
        time.sleep(3)
        # A new, paused installation must expose portal setup before its first tick.
        target = 'aarch64' if os.uname().machine == 'aarch64' else 'x86_64'
        engine = root / f'desktop/src-tauri/binaries/breadcrumb-engine-{target}-unknown-linux-gnu'
        initial = subprocess.run([str(engine), '--data-dir', str(temp / 'history'), '--capture-helper', str(binary)],
            input='{"id":1,"command":"state"}\n', env=env, text=True, capture_output=True, timeout=20, check=True)
        initial_state = json.loads(initial.stdout)['result']
        assert initial_state['capabilities']['permission'] == 'portal-required', initial_state['capabilities']
        assert not initial_state['recording']
        helper = subprocess.Popen([str(binary)], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        processes.append(helper)

        def request(command):
            helper.stdin.write(json.dumps({'command': command, 'settings': {'maximumWidth': 1280, 'jpegQuality': .65}}) + '\n')
            helper.stdin.flush()
            assert select.select([helper.stdout], [], [], 30)[0], f'{command} timed out'
            return json.loads(helper.stdout.readline())

        assert not request('capture')['ok'], 'Unattended capture must not open sharing'
        shared = request('share-source')
        assert shared['ok'], shared
        for _ in range(30):
            captured = request('capture')
            if captured['ok']:
                break
            time.sleep(.2)
        assert captured['ok'], captured
        assert base64.b64decode(captured['payload']['jpeg'], validate=True).startswith(b'\xff\xd8')
        assert captured['record']['captureScope'] == 'portal-source'
        assert captured['record']['app'] == 'Shared screen'
        assert captured['payload']['tree'] == []
        assert not captured['capabilities']['windowContext'] and not captured['capabilities']['idle']
        assert captured['capabilities']['exclusions'] == 'unavailable-for-shared-source'
        time.sleep(6)
        assert request('capture')['ok'], 'Static sources must continue providing fresh frames'
        assert request('stop-sharing')['ok']
        assert not request('capture')['ok'], 'Stopped sharing returned pixels'
        assert not request('probe')['ok'], 'Polling restarted sharing'
        assert request('share-source')['ok'], 'Reselection failed'
        portal_backend.terminate()
        portal_backend.wait(timeout=5)
        # Revocation must invalidate cached pixels, even when the source was static.
        time.sleep(6)
        assert not request('capture')['ok'], 'Revoked source returned cached pixels'
        print('Wayland portal selection, real PipeWire JPEG capture, stop/reselect, and revocation passed.')
    except BaseException:
        for log in temp.glob('*.log'):
            print(log.name + ':\n' + log.read_text()[-8000:])
            if os.environ.get('BREADCRUMB_VALIDATION_DIR'):
                destination = Path(os.environ['BREADCRUMB_VALIDATION_DIR'])
                destination.mkdir(parents=True, exist_ok=True)
                shutil.copy2(log, destination / log.name)
        raise
    finally:
        for p in reversed(processes):
            if p.poll() is None:
                p.terminate()
        for p in reversed(processes):
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
