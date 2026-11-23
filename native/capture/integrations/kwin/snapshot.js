function rect(r) {
  return {
    x: Math.floor(r.x),
    y: Math.floor(r.y),
    width: Math.ceil(r.x + r.width) - Math.floor(r.x),
    height: Math.ceil(r.y + r.height) - Math.floor(r.y),
  };
}
// Runs only on demand in KWin; no polling service, input hooks, or stored history.
const focused = workspace.activeWindow || workspace.activeClient;
const monitors = [];
if (workspace.screens && typeof workspace.screens.map === "function") {
  workspace.screens.forEach((o) => monitors.push({ id: o.name, rect: rect(o.geometry) }));
} else {
  if (typeof KWin.ScreenArea !== "number") throw new Error("KWin screen geometry unavailable");
  for (let i = 0; i < workspace.numScreens; i++) {
    monitors.push({
      id: String(i),
      rect: rect(workspace.clientArea(KWin.ScreenArea, i, workspace.currentDesktop)),
    });
  }
}
const windows = (
  typeof workspace.windowList === "function" ? workspace.windowList() : workspace.clientList()
)
  .filter((w) => !w.deleted && !w.dock && !w.desktop)
  .map((w) => ({
    id: String(w.internalId),
    pid: w.pid,
    app: String(w.resourceClass || w.desktopFileName),
    bundleID: String(w.desktopFileName || w.resourceClass),
    title: w.caption,
    rect: rect(w.frameGeometry),
    focused: w === focused,
    visible:
      !w.minimized &&
      !w.hidden &&
      (w.onAllDesktops ||
        (w.desktops
          ? w.desktops.includes(workspace.currentDesktop)
          : w.desktop === workspace.currentDesktop)),
  }));
callDBus(
  __DESTINATION__,
  "/app/breadcrumb/Desktop",
  "app.breadcrumb.Desktop",
  "Publish",
  JSON.stringify({ monitors, windows, locked: false }),
);
