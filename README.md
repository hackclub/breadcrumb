# Breadcrumb — native macOS MVP

A menu-bar-only, local-first visual history, inspired by background game recording. SwiftUI, native Liquid Glass, ScreenCaptureKit, Accessibility, CryptoKit, and AVFoundation. No web views, external packages, accounts, analytics, audio, or key logging.

## Requirements and install

- macOS 26 or later (Liquid Glass).
- The attached development build is **Apple silicon / arm64**, certificate signed when built with the configured identity, **not notarized**. Build from source for another architecture.
- Recommended local install: open `Breadcrumb-macOS-arm64.dmg`, drag Breadcrumb onto Applications, eject the image, then open the installed copy. The image includes a short setup and privacy guide. The ZIP remains available for manual installation.
- Unzip `Breadcrumb.app`, move it into Applications, and open it. It appears as a circular history icon in the **menu bar**, not the Dock. If Gatekeeper blocks the downloaded development build, use System Settings → Privacy & Security → Open Anyway after reviewing the source, or build it yourself.
- Click **Start**, review the in-app consent, and choose **Start recording**. In Breadcrumb Settings enable **Screen Recording**, and optionally **Accessibility**. Grant them in macOS Privacy & Security and relaunch when macOS requests it. If Breadcrumb is not listed, use the `+` control to add the installed app. Without Accessibility, screenshots and app/window context work but no tree is collected.
- Leave Breadcrumb in the background with another app in front. Capture follows app/window changes after a short settling delay, with a 60-second fallback; there is no retroactive capture before enabling it.

Builds use a stable Developer ID signing identity so ordinary updates can retain macOS privacy permissions. The first build selects the only available Developer ID identity and pins it in the ignored `.breadcrumb-signing-identity` file; if there are multiple identities, set `BREADCRUMB_SIGN_IDENTITY` explicitly. Missing signing keys fail the build instead of silently changing identity. Replacing old ad-hoc builds requires a one-time permission grant under the new identity. macOS may still request permission again after system changes. Notarization and clean-machine release validation remain outstanding. Launch at login uses `SMAppService` and may require approval in Login Items.

For local updates, run `bash scripts/install.sh`. It builds, checks the signing requirement, quits Breadcrumb, replaces it at its existing installation path, verifies the installed signature, and relaunches. It preserves the previous app in a temporary backup and does not reset TCC or delete capture data. Certificate-signed installs refuse an update with a changed signing requirement. Use the same signing identity with Xcode as with the scripts.

## Included

- **Continuous history** by default: compressed full-display screenshots, filtered accessibility context, local OCR, and visible-window metadata. Changes can add samples between the minute heartbeats; this is not continuous video.
- **History**: capture status, pause/start, a desktop preview and timeline scrubber, plus Save last hour. Time-range saving and label details expand when needed.
- **Capture details**: inspect focused app/window/tree context, correct labels, and save a named date/time range, including across midnight.
- **Saved**: pinned clips survive rolling expiry; review, explicitly delete, or export a 1440 × 960 H.264 MP4 at 12 frames/second. Capture timestamps remain visible; gaps are omitted, not reconstructed. Exports are **unencrypted**, outside the app's storage caps, and are not removed by library deletion.
- **Activity**: local activity/app breakdowns for the last four hours, with sampled coverage, unobserved time, and unclassified/corrected counts. Each capture represents at most 30 seconds on either side, clipped at window edges and halfway to neighboring samples; gaps are never filled. Timeline corrections update the totals. These are sampled context estimates, not attention or hours worked; no extra capture, image decoding, or AI service is used.
- **Settings**: permissions, bundle-ID exclusions, login registration, storage usage, and deletion of the last hour everywhere in the library, including saved references. Deleting recent captures also pauses recording.

## Retention and privacy

The app defaults to **Until I delete it** with a **20 GiB history limit**. Continuous mode does not expire or evict old captures: it stops accepting new captures at the limit, preserving history. Increase the limit or explicitly delete captures to resume. Saved clips use a separate configurable budget (4 GiB initially); overlapping clips pin originals rather than duplicate them. Atomic-write and metadata reserves reduce usable payload space slightly. All modes stop capture below 5 GiB free disk space and resume above 6 GiB.

Settings also offers 4-hour, 24-hour, 7-day, and 30-day rolling retention. In rolling mode, unsaved captures expire by age and storage pressure can evict the oldest earlier. Shortening retention or reducing the rolling budget asks for confirmation because older unsaved captures may be permanently removed. Saved clips stay protected. Settings persist in `settings.json` and apply without relaunch. If the app is quit, expiry waits until next launch. Sleep/lock/inactive-session signals suspend capture; missed intervals are not filled in.

Choose capture intervals from 15 seconds to 5 minutes, enable/disable change-triggered captures, adjust the minimum change interval, toggle OCR, and choose screenshot size and JPEG quality. Settings also includes launch at login, exclusion rules, storage usage, and an Open data folder button. Launch at login requires the macOS login-item registration to succeed; recording/paused intent persists across launches.

Captures, accessibility payloads, window titles, and the manifest are **unencrypted** in `~/Library/Application Support/Breadcrumb/`. The directory is private to your macOS user and excluded from backups. Anyone or any agent running with your user's file access can read it. Payloads are `<UUID>.json` (base64 JPEG plus accessibility tree); `library.json` contains capture metadata and saved references. Dates use Swift's JSON convention: seconds since 2001-01-01 UTC.

Existing AES-GCM libraries migrate automatically on startup using the existing Keychain key once. All payloads are converted before the plain manifest is atomically published; failed conversion leaves the encrypted originals intact. Legacy files are removed during subsequent successful maintenance. New libraries and subsequent launches need no key. The old Keychain item is left alone. Deletion does not guarantee forensic SSD erasure or remove exported copies.

Accessibility traversal is bounded by node count, depth, and timeout. It never requests `AXValue` and skips editable/secure subtrees. It is intentionally **not** a complete accessibility dump. Labels and screenshots can still contain private information. The full display containing the largest portion of the focused window is captured at display resolution, including wallpaper, menu bar, and other visible windows. Other monitors are not captured. Accessibility and activity labels still describe only the focused window. App exclusions also hide those apps from the display image; known password managers (including Apple Passwords) and Breadcrumb are excluded by default, but the list is not exhaustive. Captures include `captureScope: "display"` and `displayID`; older records without those fields are window captures. **Private browsing, individual sites, passwords inside other apps, and arbitrary sensitive content are not automatically detected or redacted.** Add bundle IDs or pause before sensitive work. There is no remote-control interface. The recorder keeps capture local; explicit corpus uploads are available through the agent CLI and web service described below.

Activity classification is a local, versioned rule set using app identity, focused-title cues, and exposed roles. Version 3 adds broad Browsing, Music, and Email categories plus Telegram and Discord app rules. Browser windows without a recognizable page title remain Browsing rather than guessing their purpose. It also retains conservative messaging, assistant, social, calendar, developer-page and browser-settings contexts alongside editor, terminal, reference, media and meeting contexts. Recognizable focused-page suffixes are preferred over arbitrary keywords; extension settings take precedence over media words, generic browser/repository titles remain unclassified, and Slick's identity alone does not establish messaging. “Video page” does not mean playback or attention was verified. Older browser/unknown suggestions refresh from metadata in memory when read; this does not migrate the manifest or read screenshot payloads. Manual corrections persist and always win. The UI reports **samples and bounded sampled coverage, not hours of work**. Human screenshot-reviewed research labels are separate from these production heuristics; no private analysis snapshot is embedded. Attention estimation, global shortcuts, and background browser extensions remain outside this implementation.

## Build and test

Use Xcode 26.1 or later with Swift 6.2. The package uses Swift 5 language mode. The Swift app has no third-party dependencies. Installed builds require an available signing certificate. An explicit `BREADCRUMB_SIGN_IDENTITY=- bash scripts/build.sh` can create a disposable ad-hoc preview, but the installer refuses it because changing ad-hoc builds invalidates permission identity.

```sh
bash scripts/build.sh
open build/Breadcrumb.app
```

To create the drag-to-Applications development disk image, run `bash scripts/package.sh`. The image is not a notarized public release. If Command Line Tools 27 reports a missing `SwiftUIMacros.StateMacro` plugin, select an installed macOS 26 SDK for the build, for example `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk bash scripts/package.sh`. Full Xcode is still required for XCTest UI automation.

Core tests:

```sh
swift test
```

On this MacBook's CLT Swift 6.4 setup, a fresh test build could not find the installed `TestingMacros` plugin. All eleven tests pass when it is loaded explicitly (no tests are disabled):

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk swift test \
  -Xswiftc -load-plugin-library \
  -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib
```

For the Xcode project and native UI workflow test, install XcodeGen (`brew install xcodegen`), then:

```sh
xcodegen generate
open Breadcrumb.xcodeproj
xcodebuild -project Breadcrumb.xcodeproj -scheme Breadcrumb \
  -destination 'platform=macOS' -derivedDataPath /tmp/BreadcrumbDerived test
```

Xcode/macOS may ask to allow the test runner's automation permissions. Run UI tests in a dedicated desktop session: they move the pointer, open a save dialog, and export then delete a temporary synthetic MP4. The app runs in isolated demo mode without opening your real capture library or capturing live windows. **XCTest itself records the test desktop**, including other visible apps, into the local result bundle. Use a clean session without sensitive content.

Safe synthetic preview (quit an already-running copy first):

```sh
open -n build/Breadcrumb.app --args --demo
```

Demo mode uses an ephemeral unencrypted library and twelve clearly labeled illustrative screenshots, not live screen contents. It cannot start recording. Quit and reopen normally to leave demo mode.

## Agent integration and editable rules

Use the Python 3 standard-library CLI from this checkout:

```sh
python3 agents/breadcrumb.py list
python3 agents/breadcrumb.py show CAPTURE_UUID --jpeg /tmp/capture.jpg
python3 agents/breadcrumb.py rules                      # preview
python3 agents/breadcrumb.py rules --apply              # queue labels and flags
python3 agents/breadcrumb.py label CAPTURE_UUID Reading --reason "Documentation visible" --flag review-context
```

Edit `agents/rules.py`: it is literally a function with if statements over capture metadata. Return `None` to leave a capture alone, or an activity, flags, and reason. Run it again after editing; use your own module with `rules --file /path/to/rules.py`. Rules run only when invoked, locally with your user permissions. They can be invoked by an agent or a scheduler without recompiling the app. The Swift fallback heuristics live in `Sources/BreadcrumbCore/Models.swift` (`Classification.infer`).

`list` emits JSON lines. `show` prints the filtered accessibility tree and optionally extracts the base64 JPEG. `--library /path/to/library` before the command selects a synthetic or alternate library. Do not edit the live manifest: the app is its only writer.

For other integrations, atomically rename a uniquely named JSON file into `inbox/` under the library directory. Each file is an array of `{ "id": "UUID", "activity": "Reading", "flags": ["review-context"], "reason": "Documentation visible" }`. Valid activities are listed by `label --help`. Limits: 1000 characters per reason, 20 flags of 100 characters each, and 8 MiB per batch. The app imports batches on its next refresh (normally within a minute while running), persists them, and removes consumed files. Unknown/deleted capture IDs are ignored. Invalid batches remain in the inbox and show an error; fix or remove them to resume imports. Multiple batches are applied in filename order; the last suggestion for an ID wins. Keep one integration writer per capture to avoid conflicting suggestions.

Agent suggestions persist separately from manual corrections. Manual corrections always win; “Use suggested label” restores the agent suggestion when present. Timeline details show the agent reason and flags. Flags are review hints, not evidence of attention or misconduct. Running rules with no match does not clear an earlier suggestion.

## Verification scope

Twenty-one core tests cover plain persistence, retention, saved references, atomic-write failure, legacy migration, agent labels/flags with manual correction precedence, and app/browser classification. A live full-display sample on this Mac was confirmed at 3420 × 2224 pixels with a 61-node focused-window tree. Native UI automation timed out during this update, so the simplified layout still needs visual review. Native capture permissions, real-user migration prompts, and the native UI require on-device verification. Earlier packaged builds may still use encrypted storage; rebuild to get this implementation.

## Monorepo and shared corpus

The Swift macOS app lives in `Sources/`, agent integrations in `agents/`, and the Go server plus embedded upload page in [`server/`](server/README.md). The service uses private Cloudflare R2 object storage and Loops email magic links. Invited friends sign in, create upload tokens, then explicitly contribute selected screenshots, metadata, labels, and accessibility trees. See the [server setup and API](server/README.md) for configuration, retention, and contribution instructions. The macOS app does not upload automatically.

## Context and sessions

App activation and focused-window/title notifications trigger capture after two seconds of settling, with change-triggered attempts limited to one per ten seconds. The existing minute heartbeat remains independent. Exact event screenshot duplicates with unchanged context are skipped; periodic heartbeat samples remain so static pages do not turn into artificial gaps. Apps that do not expose title/window notifications rely on the heartbeat. Pause, exclusions, and session locks still stop capture.

The focused window provides app, title, exposed browser domain, and document/project hints where available. Browser context stores only the domain, never the document URL's credentials, path, query, or fragment. Editor file/project context comes from exposed document metadata or recognizable editor titles. Metadata availability varies by app.

Each display capture also records up to twenty visible windows. Their visible fractions are geometric estimates after subtracting normal windows above them. Completely covered windows are omitted; translucent windows, overlays, and apps with poor metadata can limit accuracy. The tree still belongs only to the focused window. Vision OCR runs locally on the filtered display image, bounded to 200 lines/12,000 characters; this can include visible editable text already present in the screenshot. No keys are logged. Agents receive OCR with explicitly contributed captures.

History exposes **Visible alongside** and **Sessions**. A session groups consecutive project/domain/app context, folds in an interruption only when the original context returns within two minutes, and splits gaps longer than three minutes. Tap a session to review its captures or save its time range. `python3 agents/breadcrumb.py sessions` exports the same kind of grouping as JSON. Session spans describe observed context, not verified time worked.

Activity retains focused totals and shows alongside activity separately, with overlapping counts rather than double-counted hours. An AI assistant in focus and a side YouTube window can both be represented; visibility never establishes watching, playback, or attention. AI corpus reviews use the same distinction through the [Vercel AI Gateway worker](server/README.md#ai-agent-corpus-review).

## Rename compatibility

Breadcrumb migrates an existing `~/Library/Application Support/Rewind/` library to `~/Library/Application Support/Breadcrumb/` on first launch, preserving capture files, settings, clips, markers, and labels. If both folders exist, neither is overwritten; Breadcrumb uses its own folder. Agent CLI tools can still find the old directory before the first launch.

The internal macOS bundle identifier remains `app.rewind.local`, and legacy Keychain service identifiers remain unchanged. These are compatibility identifiers, not the product name: keeping them preserves the signing requirement, existing preferences, and macOS privacy grants. The installer replaces the previous branded app at its existing Applications location with `Breadcrumb.app` and keeps a backup. The configured R2 bucket name is an external resource and is not renamed.
