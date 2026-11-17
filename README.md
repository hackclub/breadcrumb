# Breadcrumb

A personal desktop history and an agent-reviewed activity corpus. The desktop app uses Tauri and React with a local Go engine and native capture adapters. The web/API uses Next.js, Better Auth with PostgreSQL, private Cloudflare R2 storage, and Loops email sign-in. It can run on Vercel or your own server, without a Hack Club account.

## Develop

Install Bun 1.4.4, Go 1.24+, Python 3, and stable Rust. macOS also needs Xcode with the macOS 26 SDK. Linux needs the WebKitGTK, GTK, X11, D-Bus, PipeWire, and Wayland development packages listed in `.github/workflows/desktop.yml`.

```sh
bun install --frozen-lockfile
bun install --cwd desktop --frozen-lockfile
bun install --cwd web --frozen-lockfile
python3 scripts/desktop-prepare.py
bun run --cwd desktop tauri dev
```

`bun run --cwd desktop dev` opens the UI with synthetic browser-preview data. It never records or uploads. Build a native app with `bash scripts/desktop-build.sh`. On macOS, builds use the signing identity pinned in ignored `.breadcrumb-signing-identity`; set `APPLE_SIGNING_IDENTITY` explicitly on another machine. Release signing and notarization must be configured before public distribution. Native builds support macOS, Windows, and Linux; see CI for platform build results.

```sh
bun run lint
bun run format:check
bun run test:web
bun run test:desktop
bun run test:sync
bun run build:web
bun run build:desktop
bunx playwright test
cd engine
go test -race ./...
```

Bun manages all JavaScript dependencies. Oxlint checks JavaScript/TypeScript and Oxfmt formats the project. Rust and Go retain their native package managers and formatters.

## Desktop

Breadcrumb lives in the menu bar/system tray, with no Dock/taskbar icon. Click its status icon to open a 360 × 400 overview with recording controls, a recent preview, and Save last hour. History and Settings use the same fixed-size panel; their content scrolls vertically. Back returns to the overview. Clicking away dismisses the popup. Close or Escape hides the panel while recording continues. Right-click the tray icon for pause/resume and Quit. Normal startup stays in the tray; `--show` opens the overview.

History has a desktop preview and scrubber. Sessions group nearby project/domain/app context. Saved ranges pin captures, and export as ZIP. Activity reports estimated sampled time, with overlaps and long gaps handled conservatively. Settings control retention, storage, capture intervals, change detection, image size/quality, OCR, exclusions, and startup.

Screenshots cover the full display containing the focused window. Focused activity and other visible windows are recorded separately: talking to an AI with YouTube visible alongside can represent both without claiming playback or attention. No audio or keystrokes are recorded.

- **macOS:** ScreenCaptureKit, filtered Accessibility tree, local Vision OCR. Requires macOS 26+. Screen Recording is required; Accessibility is optional. Stable bundle ID `app.rewind.local` and signing identity retain permission identity across updates; macOS may still request approval after a host or signing change.
- **Windows:** native display capture, focused/visible window context, filtered UI Automation tree. No local OCR yet.
- **Linux:** X11 native display capture and filtered AT-SPI tree. Wayland capture depends on compositor support and window metadata; unsupported sessions report a capability error. No local OCR yet.

On Windows/Linux, capture skips samples when an excluded window may be visible because those APIs cannot reliably filter arbitrary windows out of the full display. macOS excludes app windows from its capture stream. Accessibility trees skip editable/password values and have bounded traversal. Screenshots and visible labels can still contain private information.

History defaults to keeping data until deletion with a 20 GiB budget. Continuous mode stops at its limit; rolling retention may delete the oldest unsaved captures. Saved clips have a separate budget. Capture pauses below 5 GiB free disk. Shortening retention asks for confirmation; deleting recent history also pauses recording and sync.

Files are plain, unencrypted JSON and base64 JPEGs, private to the current OS user. Local paths are `~/Library/Application Support/Breadcrumb` on macOS, `%LOCALAPPDATA%/Breadcrumb` on Windows, and `$XDG_DATA_HOME/Breadcrumb` (default `~/.local/share/Breadcrumb`) on Linux. `library.json` contains metadata, `<UUID>.json` contains pixels/tree/OCR, and dates use seconds since 2001-01-01 UTC. Existing plain Swift libraries remain compatible; an existing Rewind directory migrates without overwriting an existing Breadcrumb directory. The legacy Swift migration utility remains under `Sources/` for old encrypted libraries. Build it explicitly with `bash scripts/migrate-build.sh` only when that migration is needed. Normal `scripts/build.sh`, packaging, and installation use Tauri.

## Agents and corpus

Editable if-statements in `agents/rules.py` classify and flag captures. `agents/breadcrumb.py` lists metadata, exports selected payloads, groups sessions, and explicitly contributes captures. See [agent review protocol](agents/REVIEWING.md) and [hosted API setup](web/README.md).

Recording works offline. Optional sign-in in Settings → Account opens your chosen portal in the browser. Approving the Better Auth OAuth connection starts syncing all existing and future captures, including screenshots, visible text, labels, window context, and accessibility trees. Sync resumes after restarts and connectivity loss; signing out stops uploads while local recording continues. AI corpus review is optional. Deleting local history does not delete captures already synced to the corpus.

The monorepo contains `desktop/` (Tauri/React), `engine/` (local Go process), `native/capture/` (Windows/Linux adapter), `Sources/BreadcrumbCapture*` (macOS adapter), `web/` (Next.js), and `agents/` (Python integrations).
