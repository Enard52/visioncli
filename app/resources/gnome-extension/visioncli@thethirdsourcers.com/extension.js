// VisionCLI's helper inside GNOME Shell. On Wayland, GNOME doesn't let apps list windows, read the pointer or take
// silent screenshots, so this exports a tiny session D-Bus service the VisionCLI app calls:
//
//   dev.visioncli.Shell  /dev/visioncli/Shell  (interface dev.visioncli.Shell)
//     Version()                    → s   extension protocol version
//     Windows()                    → s   JSON [{id, wm_class, app_id, app, title, pid, x, y, width, height, focus}]
//                                        on-screen normal windows of the active workspace, front-most first
//     Pointer()                    → ii  global pointer position
//     Displays()                   → s   JSON [{x, y, width, height, scale}]
//     Activate(s id)               → b   raise + focus a window (switches workspace if needed)
//     Screenshot(i x, i y, i w, i h) → ay PNG of that area of the stage (no cursor)
//
// This file is the GNOME 45+ (ESM) form. For GNOME 42–44, VisionCLI's installer rewrites the import lines into
// `imports.gi` lookups and adds init() (see toLegacyExtension in desktop/windows/gnome.ts), so keep imports one per line.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'dev.visioncli.Shell';
const OBJECT_PATH = '/dev/visioncli/Shell';
const VERSION = '1';

const IFACE = `<node>
  <interface name="dev.visioncli.Shell">
    <method name="Version"><arg type="s" direction="out" name="version"/></method>
    <method name="Windows"><arg type="s" direction="out" name="json"/></method>
    <method name="Pointer"><arg type="i" direction="out" name="x"/><arg type="i" direction="out" name="y"/></method>
    <method name="Displays"><arg type="s" direction="out" name="json"/></method>
    <method name="Activate"><arg type="s" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
    <method name="Screenshot">
      <arg type="i" direction="in" name="x"/><arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/><arg type="i" direction="in" name="height"/>
      <arg type="ay" direction="out" name="png"/>
    </method>
  </interface>
</node>`;

const TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];

/** Every window actor's window, front-most first (actors are kept in stacking order, bottom → top). */
function stackedWindows() {
    const wins = global.get_window_actors().map(a => a.get_meta_window()).filter(w => w);
    return global.display.sort_windows_by_stacking(wins).reverse();
}

function visibleWindows() {
    const ws = global.workspace_manager.get_active_workspace();
    return stackedWindows().filter(w =>
        !w.minimized && TYPES.includes(w.get_window_type()) && !w.is_skip_taskbar() && w.located_on_workspace(ws));
}

function describe(w, tracker, focus) {
    const r = w.get_frame_rect();
    const app = tracker.get_window_app(w);
    return {
        id: String(w.get_id()),
        wm_class: w.get_wm_class() || '',
        app_id: (app && app.get_id()) || w.get_gtk_application_id() || w.get_sandboxed_app_id() || '',
        app: (app && app.get_name()) || w.get_wm_class() || '',
        title: w.get_title() || '',
        pid: w.get_pid(),
        x: r.x, y: r.y, width: r.width, height: r.height,
        focus: w === focus,
    };
}

class Service {
    Version() {
        return VERSION;
    }

    Windows() {
        const tracker = Shell.WindowTracker.get_default();
        const focus = global.display.focus_window;
        return JSON.stringify(visibleWindows().map(w => describe(w, tracker, focus)));
    }

    Pointer() {
        const [x, y] = global.get_pointer();
        return [x, y];
    }

    Displays() {
        const d = global.display;
        const out = [];
        for (let i = 0; i < d.get_n_monitors(); i++) {
            const g = d.get_monitor_geometry(i);
            out.push({x: g.x, y: g.y, width: g.width, height: g.height, scale: d.get_monitor_scale(i)});
        }
        return JSON.stringify(out);
    }

    Activate(id) {
        const w = stackedWindows().find(win => String(win.get_id()) === id);
        if (!w)
            return false;
        Main.activateWindow(w);
        return true;
    }

    ScreenshotAsync([x, y, width, height], invocation) {
        try {
            const shooter = new Shell.Screenshot();
            const stream = Gio.MemoryOutputStream.new_resizable();
            shooter.screenshot_area(x, y, width, height, stream, (obj, res) => {
                try {
                    obj.screenshot_area_finish(res);
                    stream.close(null);
                    const png = GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), stream.steal_as_bytes(), true);
                    invocation.return_value(GLib.Variant.new_tuple([png]));
                } catch (e) {
                    invocation.return_dbus_error('dev.visioncli.Shell.Error.Screenshot', String(e));
                }
            });
        } catch (e) {
            invocation.return_dbus_error('dev.visioncli.Shell.Error.Screenshot', String(e));
        }
    }
}

export default class VisionCLIExtension extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, new Service());
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._owner = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        if (this._owner) {
            Gio.bus_unown_name(this._owner);
            this._owner = 0;
        }
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
    }
}
