# Linux

Breadcrumb runs on X11 and on Wayland desktops with a ScreenCast portal backend and PipeWire. Recording and history work offline without an account. Linux includes local English OCR using an embedded language model.

## Install or build

The Desktop workflow produces x86_64 and ARM64 `.deb`, `.rpm`, and `.AppImage` artifacts. Install the package matching your distribution. For AppImage, make the file executable and run it; systems without FUSE can use `--appimage-extract-and-run`. Wayland sharing uses the desktop’s ScreenCast portal and PipeWire.

For a source build, install the toolchains in [Development](development.md), plus these Debian/Ubuntu packages:

```sh
sudo apt-get install build-essential pkg-config libwebkit2gtk-4.1-dev \
  libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
  libxcb1-dev libxcb-randr0-dev libxcb-xfixes0-dev libxss1 libdbus-1-dev \
  libpipewire-0.3-dev libgbm-dev libclang-dev libwayland-dev libxkbcommon-dev \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libtesseract-dev gstreamer1.0-pipewire \
  xdg-desktop-portal at-spi2-core
bash scripts/desktop-build.sh
```

Install the portal backend appropriate for your desktop: GNOME, KDE, or a wlroots-compatible backend. Your distribution normally configures it. Run Breadcrumb in your signed-in graphical session, with the session D-Bus available. Tray visibility depends on the desktop; GNOME may need an AppIndicator extension. Launching Breadcrumb again opens the existing app.

## X11

Breadcrumb captures the display containing the focused window, records foreground and visible-window context, and reads a bounded, filtered AT-SPI accessibility tree where applications expose one. Editable and password fields are omitted from tree text. Screenshots can still contain their visible pixels.

Capture is skipped when an excluded app might be visible on that display. App exclusions accept X11 window class names. Automatic idle pause uses the XScreenSaver extension; if unavailable, Settings reports that idle detection is unavailable.

## Wayland

Open **Settings → Privacy → Share screen or window** and choose the displays Breadcrumb may capture. Sway and Hyprland use their native compositor APIs; KDE uses KWin scripting. On GNOME, use **Install GNOME desktop integration** in Privacy and enable the installed extension. A fresh login may be required.

With native desktop integration, Breadcrumb follows the focused window, checks visible apps against exclusions, and records the matching AT-SPI tree. It discards a sample if window context changes around capture. Share all displays to capture whichever one contains the focused window. Portal backends differ in their ability to identify shared displays, so ambiguous mappings pause capture.

Your desktop may remember screen-sharing permission across restarts. Pausing closes the live stream; resuming restores the grant if supported. **Stop sharing** forgets the stored grant. Idle detection uses compositor idle notifications where available, with desktop service fallbacks.

When native window integration is unavailable, shared-source mode records everything visible in the source you choose, including password managers and Breadcrumb. App exclusions and foreground attribution do not apply in that mode. Connected accounts sync screenshots and recognized text under the same rules as other captures. The portal backend and application accessibility support determine which features are available.

## Validation

CI builds native packages, runs adapter unit tests, and exercises X11 capture, focus changes, visible-app exclusions, filtered AT-SPI text, idle detection, and desktop IPC under a virtual display. Wayland tests exercise a real portal and PipeWire stream under headless Sway, including static frames, stop/reselect, and revocation. The test portal enables its shared-memory path for software rendering; shipped apps use the desktop’s own portal. Unit tests also check that background requests cannot start sharing and that padded image rows are copied correctly. Interactive portal selection and desktop-specific integrations should also be checked on the target desktop.
