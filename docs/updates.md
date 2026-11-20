# Desktop updates

Breadcrumb checks for updates shortly after launch and every four hours. Settings includes **Check for updates**, release notes and **Install & restart** with download progress. Installation requires confirmation. A failed check does not interrupt recording.

Updates use Tauri's updater, HTTPS, and a pinned public signing key. Both the artifact signature and its signed version must match; changing a manifest's version cannot turn an older signed download into a newer update. This signing is separate from Windows Authenticode and macOS signing/notarization.

## Feed

The portal serves `/api/desktop/updates/{target}/{arch}`. Targets are `windows`, `darwin` and `linux`; architectures are `x86_64` and `aarch64`. It returns Tauri's update JSON, or 204 when no artifact exists for that platform. Tauri compares the release against the installed version.

The route caches the public release manifest for one hour and never reads account or capture data. Set `DESKTOP_UPDATE_MANIFEST_URL` to another HTTPS manifest when self-hosting. The default is the `latest.json` asset on the repository's Windows preview release. Missing platforms are not offered an update.

The desktop first polls `https://breadcrumb.hackclub.com`, then the public GitHub manifest. This keeps checks working while Vercel deployment protection is enabled. No protection-bypass secret is shipped in the desktop. Deployment protection still controls normal portal/API access.

## Publish an update

1. Update the app version and code through a pull request. Merge after review and relevant checks.
2. Download the tested `Breadcrumb-Windows-x64-setup` artifact from the main-branch Desktop workflow. It contains the offline first-install setup, a lightweight update installer, and version-bound `.sig` files when signing is configured. Updates omit the bundled WebView2 runtime because the running app already has it.
3. Upload the installer and signature to the release. Use a durable public HTTPS download URL; do not use an expiring private capture URL.
4. Generate the manifest, adding each available platform with its actual signature:

```sh
bun run release:manifest \
  --platform windows-x86_64 \
  --url https://github.com/hackclub/breadcrumb/releases/download/windows-preview/Breadcrumb-Windows-x64-update.exe \
  --signature path/to/Breadcrumb-Windows-x64-update.exe.sig \
  --notes path/to/release-notes.md
```

5. Upload `build/latest.json` as the release's `latest.json` asset **last**, after its downloads are available. Check a manual update from the previous version. The website will refresh its cached feed within an hour.

The manifest command takes the version from `tauri.conf.json`, merges platforms for that version, and starts a new platform list when the version changes. It writes ignored build output, so publishing release metadata does not require a source commit. Configure a different output with `--output`.

## Signing and other platforms

Windows CI signs main-branch installers after lifecycle tests, using repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Pull requests and forks do not require the private key and cannot use it. The public key is in `desktop/src-tauri/tauri.conf.json`. Keep the original private key and its password backed up; replacing it prevents existing clients trusting future releases.

For a local signed build, set Tauri's signing environment variables, prepare native helpers, and enable the updater artifact override:

```sh
python3 scripts/desktop-prepare.py
bun run --cwd desktop tauri build --config src-tauri/tauri.updater.conf.json
```

Tauri generates `.app.tar.gz` plus `.sig` for macOS, AppImage plus `.sig` for Linux, and installer signatures for Windows. Publish only platform/architecture pairs that were actually built and tested. Linux package-manager installations should continue using their package manager; the updater artifact is an AppImage.

To sign an existing Windows installer manually, use `tauri signer sign --app-version VERSION` with the same private key. Signatures without the version binding are rejected by these clients. Changing update hosts does not require changing the signing key. Self-hosted builds can replace both configured feed endpoints and the public key.

Existing builds without the updater need one manual installation of an updater-enabled build. They cannot acquire updater support by polling a route they do not yet know about.
