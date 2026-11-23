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
    data = temp / 'data'
    (data / 'applications').mkdir(parents=True)
    (data / 'applications/app.rewind.local.desktop').write_text('[Desktop Entry]\nName=Breadcrumb\nType=Application\nExec=breadcrumb-desktop\nNoDisplay=true\n')
    config = temp / 'config'
    backend = config / 'xdg-desktop-portal-wlr'
    backend.mkdir(parents=True)
    (backend / 'config').write_text('[screencast]\nchooser_type=none\noutput_name=HEADLESS-1\nmax_fps=5\n')
    (temp / 'sway.conf').write_text('output * bg #335577 solid_color\n')
    env = {**os.environ, 'XDG_RUNTIME_DIR': str(runtime), 'XDG_CONFIG_HOME': str(config),
           'XDG_DATA_HOME': str(data), 'XDG_STATE_HOME': str(temp / 'state'), 'GDK_BACKEND': 'wayland', 'NO_AT_BRIDGE': '0', 'GTK_MODULES': 'gail:atk-bridge',
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
            ipc = [p for p in runtime.glob('sway-ipc.*.sock') if p.is_socket()]
            if sockets and ipc:
                break
            time.sleep(.1)
        assert sockets and ipc, 'Headless Wayland compositor did not start'
        env['WAYLAND_DISPLAY'] = sockets[0].name
        env['SWAYSOCK'] = str(ipc[0])
        subprocess.run(['dbus-update-activation-environment', *[f'{k}={env[k]}' for k in
            ['WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']]], check=True)
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
        fixture = launch(['/usr/bin/python3', str(root / 'scripts/linux-tree-fixture.py')])
        time.sleep(1)
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

        def request(command, exclusions=None, settings=None):
            helper.stdin.write(json.dumps({'command': command, 'settings': {'maximumWidth': 1280, 'jpegQuality': .65, 'recognizeText': True, **(settings or {})}, 'exclusions': exclusions or []}) + '\n')
            helper.stdin.flush()
            assert select.select([helper.stdout], [], [], 30)[0], f'{command} timed out'
            return json.loads(helper.stdout.readline())

        assert not request('capture')['ok'], 'Unattended capture must not open sharing'
        shared = request('share-source')
        assert shared['ok'], shared
        for attempt in range(30):
            # Screencopy is damage-driven. A headless desktop can become static
            # before PipeWire subscribes, so explicitly repaint after sharing
            # starts instead of waiting for incidental compositor activity.
            if attempt % 5 == 0:
                color = '#335577' if attempt % 10 else '#446688'
                subprocess.run(['swaymsg', '-s', str(ipc[0]),
                    f'output HEADLESS-1 bg {color} solid_color'],
                    env=env, capture_output=True, timeout=5, check=True)
            captured = request('capture')
            if captured['ok']:
                break
            time.sleep(.2)
        assert captured['ok'], captured
        assert base64.b64decode(captured['payload']['jpeg'], validate=True).startswith(b'\xff\xd8')
        assert captured['record']['captureScope'] == 'display'
        assert captured['record']['windowTitle'] == 'Synthetic GTK fixture'
        for _ in range(20):
            if 'PUBLIC_LABEL_SENTINEL' in json.dumps(captured['payload']['tree']):
                break
            time.sleep(.2)
            captured = request('capture')
            assert captured['ok'], captured.get('error')
        assert 'PUBLIC_LABEL_SENTINEL' in json.dumps(captured['payload']['tree']), (captured['record']['treeStatus'], captured['payload']['tree'])
        assert all(value not in json.dumps(captured['payload']['tree']) for value in ['EDITABLE_VALUE_SENTINEL', 'PASSWORD_VALUE_SENTINEL', 'COMBO_EDITABLE_SENTINEL'])
        assert 'PUBLIC' in captured['payload']['screenText'], captured['record']['ocrStatus']
        assert captured['capabilities']['windowContext'] and captured['capabilities']['idle']
        assert captured['capabilities']['ocr']
        excluded = request('capture', exclusions=[captured['record']['bundleID'].upper()])
        assert not excluded.get('contextKey') and 'payload' not in excluded
        assert captured['capabilities']['exclusions'] == 'skip-when-visible'
        time.sleep(6)
        static = request('capture')
        assert static['ok'], f'Static sources must continue providing fresh frames: {static}'
        assert request('suspend-sharing')['ok']
        assert not request('capture')['ok']
        # Restore is explicit in the protocol and runs only when the engine's
        # recording intent is on; ordinary probes never reopen a chooser.
        restored = request('resume-sharing')
        assert restored['ok'], restored
        assert request('stop-sharing')['ok']
        assert not request('capture')['ok'], 'Stopped sharing returned pixels'
        assert not request('probe')['ok'], 'Polling restarted sharing'
        assert request('resume-sharing')['ok']
        assert not request('capture')['ok'], 'Forgotten grant restored sharing'
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
        # The D-Bus-activated document portal can keep a FUSE mount alive after
        # our child processes exit. Unmount it before TemporaryDirectory cleanup.
        documents = runtime / 'doc'
        if os.path.ismount(documents):
            unmount = shutil.which('fusermount3') or shutil.which('fusermount')
            assert unmount, 'Document portal mount needs fusermount for cleanup'
            subprocess.run([unmount, '-u', str(documents)], check=True)
