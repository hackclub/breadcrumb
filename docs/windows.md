# Windows setup

Breadcrumb uses a per-user Nullsoft (NSIS) installer. It installs the app and both native helpers. Windows 10 and 11 already include the Microsoft Edge WebView2 runtime; if it is missing, setup downloads and installs it silently, which needs an internet connection. No development tools are needed.

## Install

1. Download [Breadcrumb for Windows x64](https://github.com/hackclub/breadcrumb/releases/download/windows-preview/Breadcrumb-Windows-x64-setup.exe) from the [preview release](https://github.com/hackclub/breadcrumb/releases/tag/windows-preview).
2. Run setup for your Windows account. It does not request administrator access.
3. Finish setup and open Breadcrumb. The first launch is paused; press **Start** when you are ready to record, then return to another app.

Breadcrumb lives in the system tray. A normal Windows launch opens its overview; launching at login stays in the tray. Closing the popup leaves recording running. Use the tray menu to quit, or the recording control to pause. **Launch at login** is optional.

Recording works without an account. To sync, open **Settings → Account**, enter your chosen portal URL, and approve the connection in your browser. This uploads existing and future captures; the installer does not sign you in or enable uploads itself.

## Capture access

Standard Windows desktop capture has no separate macOS-style permission grant. Breadcrumb runs as your normal user; protected windows and administrator-only applications may cause samples to be skipped when their executable identity cannot be checked. Lock screens, secure desktops and background service sessions cannot be recorded. Resume in your signed-in desktop to recover.

Capture includes the display containing the focused window. Accessibility context is filtered, but screenshots can contain private information. Password managers and Breadcrumb itself are excluded by default. When an excluded app may be visible on the display, the sample is skipped rather than pretending its pixels were removed.

## Repair, updates and uninstall

Run the installer again to repair missing app files. Updates retain your settings, recording preference and local history. Missing helpers or an unusable WebView2 runtime produce a native repair message; they do not silently use development binaries.

Uninstall through Windows Settings or the supplied uninstaller. Normal uninstall retains your history at `%LOCALAPPDATA%\Breadcrumb` and removes login startup registration. **Delete app data** permanently removes that local library and its connection settings. It does not withdraw captures already synced to a portal. The shared WebView2 runtime remains available to other applications.

For later releases, **Settings → Updates** checks for a signed update and offers installation with a restart. See [desktop updates](updates.md).

## Preview status

Preview builds are unsigned and may trigger Windows reputation warnings. Signing is still required for a release that avoids those warnings. An installer cannot override organizational policies or grant itself access to protected windows.

Windows setup is built and lifecycle-tested in CI. Real interactive tests use an unelevated Windows desktop through the Amp runner. See the [validation report](windows-testing.md) for coverage and untested scenarios.

## Build and test

On Windows, install the development prerequisites in [the development guide](development.md), then run:

```powershell
bun install --cwd desktop --frozen-lockfile
python scripts/desktop-prepare.py
bun run --cwd desktop tauri build --bundles nsis
```

Setup is produced under `desktop/src-tauri/target/release/bundle/nsis/`. CI retains a `Breadcrumb-Windows-x64-setup` artifact.

The silent lifecycle check must run only in a disposable Windows account. It refuses an existing installation or library and tests installation, repair, path handling, data retention, reinstall, and explicit data deletion:

```powershell
./scripts/windows-installer-smoke.ps1 -Installer 'path\to\Breadcrumb-setup.exe'
```
