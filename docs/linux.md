# Linux

Breadcrumb runs on X11 and on Wayland desktops with a ScreenCast portal backend and PipeWire. Recording and history work offline without an account. Linux does not currently provide local OCR.

## Install or build

The Desktop workflow produces x86_64 `.deb`, `.rpm`, and `.AppImage` artifacts. Install the package matching your distribution. For AppImage, make the file executable and run it; systems without FUSE can use `--appimage-extract-and-run`. AppImages still need the host's PipeWire GStreamer plugin and desktop portal backend for Wayland sharing.

For a source build, install the toolchains in [Development](development.md), plus these Debian/Ubuntu packages:

```sh
sudo apt-get install build-essential pkg-config libwebkit2gtk-4.1-dev \
  libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
  libxcb1-dev libxcb-randr0-dev libxcb-xfixes0-dev libxss1 libdbus-1-dev \
  libpipewire-0.3-dev libgbm-dev libclang-dev libwayland-dev libxkbcommon-dev \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev gstreamer1.0-pipewire \
  xdg-desktop-portal at-spi2-core
bash scripts/desktop-build.sh
```

Install the portal backend appropriate for your desktop: GNOME, KDE, or a wlroots-compatible backend. Your distribution normally configures it. Run Breadcrumb in your signed-in graphical session, with the session D-Bus available. Tray visibility depends on the desktop; GNOME may need an AppIndicator extension. Launching Breadcrumb again opens the existing app.

## X11

Breadcrumb captures the display containing the focused window, records foreground and visible-window context, and reads a bounded, filtered AT-SPI accessibility tree where applications expose one. Editable and password fields are omitted from tree text. Screenshots can still contain their visible pixels.

Capture is skipped when an excluded app might be visible on that display. App exclusions accept X11 window class names. Automatic idle pause uses the XScreenSaver extension; if unavailable, Settings reports that idle detection is unavailable.

## Wayland

Open **Settings → Privacy → Share screen or window**, accept the capture notice, and choose a source in your desktop's picker. Breadcrumb keeps this sharing session open and samples it at your configured interval. It does not prompt during ordinary background polling or reuse permission after restarting. Pausing recording or choosing **Stop sharing** ends the session. Choose a source again after resuming.

**Everything visible in the chosen source can be captured, including Breadcrumb and password managers. App exclusions cannot be enforced in this mode.** Prefer sharing a single window if your desktop offers that option. Connected accounts sync these screenshots under the same rules as other captures.

Wayland captures are labeled **Shared screen**. They do not claim foreground-app attribution, visible-window context, accessibility trees, automatic idle pause, or capture-on-app-change. Use an X11 login session when you need those features. XWayland window lists are deliberately not used to infer native Wayland windows or enforce exclusions.

The [ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html) provides the selected PipeWire stream, not a portable foreground-window inventory. Source choices and permission behavior depend on your desktop backend. Cancellation, revoked sharing, missing plugins, and unavailable portals are reported without falling back to unrestricted screenshots.

## Validation

CI builds native packages, runs adapter unit tests, and exercises X11 capture, focus changes, visible-app exclusions, filtered AT-SPI text, idle detection, and desktop IPC under a virtual display. Wayland tests exercise a real portal and PipeWire stream under headless Sway, including static frames, stop/reselect, and revocation. The test portal enables its shared-memory path for software rendering; shipped apps use the desktop’s own portal. Unit tests also check that background requests cannot start sharing and that padded image rows are copied correctly. Interactive portal selection and revocation still need desktop testing on GNOME, KDE, and wlroots before claiming equivalent behavior across them.
