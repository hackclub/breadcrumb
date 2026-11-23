import Gio from "gi://Gio";
import Shell from "gi://Shell";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
const rect = (r) => ({
  x: Math.floor(r.x),
  y: Math.floor(r.y),
  width: Math.ceil(r.x + r.width) - Math.floor(r.x),
  height: Math.ceil(r.y + r.height) - Math.floor(r.y),
});
const XML =
  '<node><interface name="app.breadcrumb.Desktop"><method name="Snapshot"><arg type="s" direction="out"/></method></interface></node>';
export default class Breadcrumb extends Extension {
  enable() {
    this._object = Gio.DBusExportedObject.wrapJSObject(XML, this);
    this._object.export(Gio.DBus.session, "/app/breadcrumb/Desktop");
  }
  disable() {
    this._object?.unexport();
    this._object = null;
  }
  Snapshot() {
    const tracker = Shell.WindowTracker.get_default();
    const monitors = [];
    for (let i = 0; i < global.display.get_n_monitors(); i++) {
      monitors.push({ id: String(i), rect: rect(global.display.get_monitor_geometry(i)) });
    }
    const locked = Main.sessionMode.isLocked;
    const windows = locked
      ? []
      : global.get_window_actors().map((actor) => {
          const w = actor.meta_window;
          const app = tracker.get_window_app(w);
          return {
            id: String(w.get_stable_sequence()),
            pid: w.get_pid(),
            app: app?.get_name() || w.get_wm_class() || "",
            bundleID: app?.get_id() || w.get_wm_class() || "",
            title: w.get_title() || "",
            rect: rect(w.get_frame_rect()),
            focused: w === global.display.focus_window,
            visible: !w.minimized && w.showing_on_its_workspace(),
          };
        });
    return JSON.stringify({ monitors, windows, locked });
  }
}
