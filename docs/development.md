# Development

Install Bun 1.4.4, Go 1.26+, Python 3, and stable Rust. macOS builds need a recent Xcode/Command Line Tools Swift toolchain; the shipped app targets macOS 14 Sonoma or newer on Intel and Apple Silicon. Linux needs the WebKitGTK, GTK, X11, D-Bus, PipeWire, GStreamer, and Wayland development packages listed in `.github/workflows/desktop.yml`.

```sh
bun install --frozen-lockfile
bun install --cwd desktop --frozen-lockfile
bun install --cwd web --frozen-lockfile
python3 scripts/desktop-prepare.py
bun run --cwd desktop tauri dev
```

`bun run --cwd desktop dev` opens the UI with synthetic browser-preview data. It never records or uploads. Build a native app with `bash scripts/desktop-build.sh`. On macOS, builds use the signing identity pinned in ignored `.breadcrumb-signing-identity`; set `APPLE_SIGNING_IDENTITY` explicitly on another machine. See [macOS packaging](macos.md) for signed downloads and notarization. Native builds support macOS, Windows, and Linux; see CI for platform build results and [Linux setup](linux.md) for packages and session differences.

```sh
bun run lint
bun run format:check
bun run test:web
bun run test:desktop
bun run test:sync
bun run test:dashboard
bun run build:web
bun run build:desktop
bunx playwright test
cd engine
go test -race ./...
```

Bun manages all JavaScript dependencies. Oxlint checks JavaScript/TypeScript and Oxfmt formats the project. Rust and Go retain their native package managers and formatters.

## Agents and corpus

Editable if-statements in `agents/rules.py` classify and flag captures. `agents/breadcrumb.py` lists metadata, exports selected payloads, groups sessions, and explicitly contributes captures. See [agent review protocol](../agents/REVIEWING.md) and [hosted API setup](../web/README.md).

Recording works offline. Optional sign-in in Settings → Account opens your chosen portal in the browser. Approving the Better Auth OAuth connection starts syncing all existing and future captures, including screenshots, visible text, labels, window context, and accessibility trees. Sync resumes after restarts and connectivity loss; signing out stops uploads while local recording continues. AI corpus review is optional. Deleting local history does not delete captures already synced to the corpus.

The monorepo contains `desktop/` (Tauri/React), `engine/` (local Go process), `native/capture/` (Windows/Linux adapter), `Sources/BreadcrumbCapture*` (macOS adapter), `web/` (Next.js), and `agents/` (Python integrations).

## Automation

Dependabot groups weekly Bun, Go, Rust, and GitHub Actions updates. CI checks formatting, lint, high/critical JavaScript advisories, Go vet/race tests, native builds on all three platforms, and browser/Better Auth sync flows. The dashboard regression also checks delayed loading, category drilldowns, keyboard focus, and zero layout shift on desktop and mobile. Failed UI runs retain screenshots for seven days. New pushes cancel outdated runs; the main checks also run weekly.

Lint, formatting, each package’s dependency audit, desktop unit tests, web unit tests, and the web build appear as separate GitHub checks. They run independently; one failure does not cancel the others.

## Linux GLib security backport

Tauri’s GTK3 dependency requires GLib 0.18. The desktop pins a local copy of GLib 0.18.5 with the upstream `VariantStrIter` soundness fix backported; its version and MIT license are retained. See [patch provenance](../desktop/src-tauri/vendor/glib/BREADCRUMB_PATCH.md). Linux CI runs the upstream iterator tests in release mode. Remove the override when Tauri accepts a fixed upstream GLib release.

## Profiles

Profiles use the existing Better Auth session and an additive PostgreSQL schema. Run `bun run --cwd web profiles:migrate` with the portal's configured `DATABASE_URL` before enabling profile routes. A signed-in, verified account can reserve one permanent username at `/profile`, choose a display name and bio, and manage visibility. Public profiles live at `/u/<username>`.

A public profile exposes its chosen identity. App sharing is separately opt-in and includes only selected catalog entries; screenshots, titles, emails, capture history and time totals stay private. A private profile returns the same404 as an unknown name, and profile responses are not cached. Username reservations are enforced atomically in PostgreSQL.

`bun run test:profiles` checks the UI on desktop and mobile. The separate PostgreSQL CI check exercises real reservation races, ownership, Better Auth cookies, privacy changes, and account cleanup in a disposable local database.
