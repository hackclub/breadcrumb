# macOS

Download Breadcrumb for Apple Silicon or Intel from the [download page](https://breadcrumb.hackclub.com/download). Requires macOS 14 or later.

The current Mac downloads are Developer ID signed previews. Notarization is pending. If macOS blocks the first launch, use Open Anyway in System Settings → Privacy & Security.

Drag Breadcrumb into Applications and open it. The app stays in the menu bar. Press Start and allow Screen Recording when asked. Accessibility is optional and adds window context.

Open Dashboard to explore local apps, categories, projects, days and hours. Recording and insights work without an account or internet connection. Sign in from Settings only when you want to sync.

Updates preserve history and settings and require confirmation before restarting. Keep the installed app in Applications so permissions continue referring to the same copy.

## Packaging

CI builds packages for both Mac architectures. Public packages are signed on the release Mac; the Developer ID private key does not need to be copied to CI.

```sh
python3 scripts/macos-release.py --target aarch64-apple-darwin
python3 scripts/macos-release.py --target x86_64-apple-darwin
```

Set `APPLE_SIGNING_IDENTITY` and the existing Tauri updater signing variables. For notarization, use `BREADCRUMB_NOTARY_PROFILE` with credentials stored by Apple's `notarytool`, or standard `APPLE_API_KEY_PATH`/`APPLE_API_KEY`/`APPLE_API_ISSUER` credentials. Apple ID app-specific credentials are also supported.

The script verifies signatures and helper architectures, notarizes and staples the app and disk image, and signs the updater archive. Publish the DMGs and versioned `.app.tar.gz` archives with their signatures before updating the release manifest. Add both `darwin-aarch64` and `darwin-x86_64` entries using `bun run release:manifest`.

`--unsigned` produces CI artifacts. `--skip-notarization` produces a signed local preview. Neither is a notarized release; label signed previews clearly when sharing them.
