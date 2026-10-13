import { test } from "node:test";
import assert from "node:assert/strict";
import { cropFor, fitSize, jpegSize, keepWindow, magickEncode, pngSize, union, type Tools } from "../../src/main/desktop/windows/common";
import { frameBounds, parseWinTree, isRegularWindow, parseActiveWindow, parseRootSize, parseWmctrlRows, parseXrandrMonitors, X11Desktop } from "../../src/main/desktop/windows/x11";
import { parseSwayOutputs, parseSwayTree, prettyApp, grimGeometry } from "../../src/main/desktop/windows/sway";
import { parseHyprClients, parseHyprCursor, parseHyprMonitors, type HyprClient } from "../../src/main/desktop/windows/hyprland";
import { parseShellDisplays, parseShellVersion, parseShellWindows } from "../../src/main/desktop/windows/gnome";
import { fillKWinScript, parseKWinSnapshot } from "../../src/main/desktop/windows/kde";
import { requestPath } from "../../src/main/desktop/windows/portal";
import { detectBackend } from "../../src/main/desktop/windows/index";

const win = (pid: number | undefined, w = 800, h = 600, appId = "x") =>
  ({ id: "1", app: "X", appId, title: "", pid, bounds: { x: 0, y: 0, width: w, height: h } });

test("keepWindow drops our own pid, tiny windows and VisionCLI by class", () => {
  const own = new Set([42]);
  assert.equal(keepWindow(win(1), own), true);
  assert.equal(keepWindow(win(42), own), false);
  assert.equal(keepWindow(win(1, 199, 600), own), false);
  assert.equal(keepWindow(win(1, 800, 149), own), false);
  assert.equal(keepWindow(win(undefined, 800, 600, "visioncli.VisionCLI"), own), false);
});

test("fitSize matches Screen.encode (1568 longest side, never upscales)", () => {
  assert.deepEqual(fitSize(3136, 1960), { width: 1568, height: 980 });
  assert.deepEqual(fitSize(1000, 3000), { width: 523, height: 1568 });
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 });
});

test("cropFor scales layout coordinates to device pixels and clamps", () => {
  const layout = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(cropFor({ x: 100, y: 50, width: 400, height: 300 }, layout, { width: 3840, height: 2160 }), { x: 200, y: 100, width: 800, height: 600 });
  assert.deepEqual(cropFor({ x: 1800, y: -20, width: 400, height: 100 }, layout, { width: 1920, height: 1080 }), { x: 1800, y: 0, width: 120, height: 80 });
  assert.deepEqual(union([{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: -200, width: 1280, height: 1024 }]), { x: 0, y: -200, width: 3200, height: 1280 });
});

test("pngSize and jpegSize read headers", () => {
  const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(pngSize(png), { width: 640, height: 480 });
  // SOI, APP0 (len 4), SOF0 with h=300 w=500
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0xf4, 3, 0, 0, 0, 0]);
  assert.deepEqual(jpegSize(jpg), { width: 500, height: 300 });
});

test("magickEncode crops then resizes to the computed size at q85", async () => {
  const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(4000, 16); png.writeUInt32BE(3000, 20);
  let seen: string[] = [];
  const tools: Tools = { text: async () => "", bytes: async (_c, a) => { seen = a; return Buffer.from([0xff, 0xd8]); } };
  const j = await magickEncode(tools, "convert", png, { x: 10, y: 20, width: 3136, height: 1000 });
  assert.deepEqual(seen, ["png:-", "-alpha", "off", "-crop", "3136x1000+10+20", "+repage", "-resize", "1568x500!", "-strip", "-quality", "85", "jpg:-"]);
  assert.equal(j.width, 1568); assert.equal(j.height, 500);
});

// ── X11 ──

const WMCTRL = `0x01400003  0 1234   10   20   800  600  gedit.Gedit           host Untitled Document 1 - gedit
0x01600007 -1 99    0    0    1920 30   tint2.Tint2           host tint2
0x01800003  1 555   0    0    640  480  xterm.XTerm           host other desktop
0x01a00004  0 777   100  100  500  400  N/A                   host
`;

test("parseWmctrlRows keeps pid, class and decimal id", () => {
  const rows = parseWmctrlRows(WMCTRL);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { id: String(0x01400003), desktop: 0, pid: 1234, app: "Gedit", appId: "gedit.Gedit", title: "Untitled Document 1 - gedit", bounds: { x: 10, y: 20, width: 800, height: 600 } });
  assert.equal(rows[3].appId, "");
});

test("xrandr, xdpyinfo, active window and window type parsing", () => {
  assert.deepEqual(parseXrandrMonitors("Monitors: 2\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n 1: +HDMI-1 1920/510x1080/290+2560+-100  HDMI-1\n"),
    [{ x: 0, y: 0, width: 2560, height: 1440 }, { x: 2560, y: -100, width: 1920, height: 1080 }]);
  assert.deepEqual(parseRootSize("screen #0:\n  dimensions:    1280x800 pixels (338x211 millimeters)"), { x: 0, y: 0, width: 1280, height: 800 });
  assert.equal(parseActiveWindow("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1400003"), String(0x1400003));
  assert.equal(parseActiveWindow("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0"), null);
  assert.equal(isRegularWindow("_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL\n_NET_WM_STATE(ATOM) = "), true);
  assert.equal(isRegularWindow("_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DOCK"), false);
  assert.equal(isRegularWindow("_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL\n_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN"), false);
  assert.equal(isRegularWindow("_NET_WM_WINDOW_TYPE:  not found."), true);
});

test("xwininfo tree + frame extents give on-screen bounds (wmctrl -G double-counts the frame offset)", () => {
  const tree = parseWinTree(`     0x40012f "gedit": ()  10x10+-100+-100  +-100+-100
        0x80000c "xterm": ("xterm" "XTerm")  604x394+1+20  +401+120
        0x60000c "xclock": ("xclock" "XClock")  300x300+1+20  +-51+70`);
  assert.deepEqual(tree.get(String(0x80000c)), { x: 401, y: 120, width: 604, height: 394 });
  assert.deepEqual(tree.get(String(0x60000c)), { x: -51, y: 70, width: 300, height: 300 });
  assert.deepEqual(frameBounds({ x: 401, y: 120, width: 604, height: 394 }, "_NET_FRAME_EXTENTS(CARDINAL) = 1, 1, 20, 5"), { x: 400, y: 100, width: 606, height: 419 });
  assert.deepEqual(frameBounds({ x: 100, y: 100, width: 900, height: 700 }, "_GTK_FRAME_EXTENTS(CARDINAL) = 26, 26, 23, 29"), { x: 126, y: 123, width: 848, height: 648 });
});

test("X11Desktop.windows: current desktop, front-most first, no docks/minimized/own", async () => {
  const stack = `_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1600007, 0x1a00004, 0x1400003, 0x1800003`;
  const tools: Tools = {
    bytes: async () => Buffer.alloc(0),
    text: async (cmd, args) => {
      if (cmd === "wmctrl" && args[0] === "-lpGx") return WMCTRL.replace(" 777 ", ` ${process.pid} `);
      if (cmd === "wmctrl" && args[0] === "-d") return "0  * DG: 1920x1080  VP: 0,0  WA: 0,0 1920x1080  one\n1  - DG: x\n";
      if (cmd === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") return `window id # 0x1a00004`;
      if (cmd === "xprop" && args[0] === "-root") return stack;
      if (cmd === "xprop") return args[1] === String(0x01600007) ? "_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DOCK" : "_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL";
      throw new Error(cmd);
    },
  };
  const d = new X11Desktop(tools, async () => ({ data: Buffer.alloc(0), width: 0, height: 0 }));
  const ws = await d.windows();
  assert.deepEqual(ws.map((w) => w.app), ["Gedit"]);
  // The active window is ours (the overlay) → the user's app behind it.
  assert.equal((await d.activeWindow())?.app, "Gedit");
});

// ── Sway ──

test("parseSwayTree: visible views, floating above tiled, by focus recency", () => {
  const view = (id: number, app: string, extra: object = {}) => ({ id, type: "con", app_id: app, pid: id * 10, name: app, visible: true, rect: { x: id, y: 0, width: 500, height: 400 }, nodes: [], floating_nodes: [], ...extra });
  const tree = {
    id: 1, type: "root", rect: { x: 0, y: 0, width: 0, height: 0 }, focus: [3], nodes: [
      { id: 3, type: "output", rect: { x: 0, y: 0, width: 1920, height: 1080 }, focus: [4, 9], nodes: [
        { id: 4, type: "workspace", rect: { x: 0, y: 0, width: 1920, height: 1080 }, focus: [6, 5, 7],
          layout: "splith", nodes: [view(5, "foot"), view(6, "org.gnome.gedit", { focused: true, border: "normal", rect: { x: 960, y: 27, width: 960, height: 1053 }, deco_rect: { x: 0, y: 0, width: 960, height: 27 } })],
          floating_nodes: [{ ...view(7, "pavucontrol"), type: "floating_con" }] },
        { id: 9, type: "workspace", rect: { x: 0, y: 0, width: 1920, height: 1080 }, focus: [10], nodes: [view(10, "firefox", { visible: false })] },
      ] },
    ],
  };
  const ws = parseSwayTree(tree as any);
  assert.deepEqual(ws.map((w) => w.appId), ["pavucontrol", "org.gnome.gedit", "foot"]);
  assert.equal(ws[1].app, "Gedit");
  assert.equal(ws[1].focused, true);
  assert.deepEqual(ws[1].bounds, { x: 960, y: 0, width: 960, height: 1080 }); // title bar included
  assert.equal(prettyApp("firefox"), "Firefox");
  assert.equal(grimGeometry({ x: 10, y: 20, width: 300.4, height: 200 }), "10,20 300x200");
  assert.deepEqual(parseSwayOutputs([{ active: true, rect: { x: 0, y: 0, width: 1280, height: 720 } }, { active: false, rect: { x: 0, y: 0, width: 0, height: 0 } }]), [{ x: 0, y: 0, width: 1280, height: 720 }]);
});

// ── Hyprland ──

test("Hyprland clients, monitors and cursor", () => {
  const c = (address: string, ws: number, hist: number, extra: Partial<HyprClient> = {}): HyprClient =>
    ({ address, mapped: true, hidden: false, at: [0, 0], size: [800, 600], workspace: { id: ws }, class: "kitty", title: address, pid: 5, focusHistoryID: hist, ...extra });
  const mons = [{ x: 0, y: 0, width: 3840, height: 2160, scale: 2, transform: 0, activeWorkspace: { id: 1 }, specialWorkspace: { id: 0 } }];
  const ws = parseHyprClients([c("0xa", 1, 0), c("0xb", 1, 2, { floating: true }), c("0xc", 2, 1), c("0xd", 1, 3, { hidden: true })], mons);
  assert.deepEqual(ws.map((w) => w.id), ["0xb", "0xa"]);
  assert.deepEqual(parseHyprMonitors(mons), [{ x: 0, y: 0, width: 1920, height: 1080 }]);
  assert.deepEqual(parseHyprMonitors([{ x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 1 }]), [{ x: 0, y: 0, width: 1080, height: 1920 }]);
  assert.deepEqual(parseHyprCursor("1234, 567\n"), { x: 1234, y: 567 });
});

// ── GNOME / KDE / portal ──

test("GNOME extension JSON parsing", () => {
  const ws = parseShellWindows(JSON.stringify([{ id: "12", wm_class: "org.gnome.TextEditor", app_id: "org.gnome.TextEditor.desktop", app: "Text Editor", title: "notes", pid: 300, x: 5, y: 6, width: 700, height: 500, focus: true }]));
  assert.deepEqual(ws[0], { id: "12", app: "Text Editor", appId: "org.gnome.TextEditor", title: "notes", pid: 300, bounds: { x: 5, y: 6, width: 700, height: 500 }, focus: true });
  assert.deepEqual(parseShellDisplays('[{"x":0,"y":0,"width":2560,"height":1440,"scale":2}]'), [{ x: 0, y: 0, width: 2560, height: 1440 }]);
  assert.equal(parseShellVersion("GNOME Shell 46.2\n"), 46);
});

test("KWin snapshot parsing and script templating", () => {
  const snap = parseKWinSnapshot(JSON.stringify({
    windows: [{ id: "{abc}", resourceClass: "org.kde.dolphin", resourceName: "dolphin", desktopFile: "org.kde.dolphin", caption: "Home", pid: 9, rect: { x: 1, y: 2, width: 900, height: 700 }, active: true }],
    cursor: { x: 3, y: 4 }, screens: [{ x: 0, y: 0, width: 1920, height: 1080 }],
  }));
  assert.equal(snap.windows[0].app, "Dolphin");
  assert.equal(snap.windows[0].appId, "org.kde.dolphin");
  assert.deepEqual(snap.cursor, { x: 3, y: 4 });
  assert.throws(() => parseKWinSnapshot('{"error":"boom"}'), /boom/);
  const filled = fillKWinScript('const REQUEST = /*REQUEST*/{ "token": "" }/*END*/;', { token: "t1", action: "snapshot" });
  assert.equal(filled, 'const REQUEST = {"token":"t1","action":"snapshot"};');
});

test("portal request path", () => {
  assert.equal(requestPath(":1.234", "tok"), "/org/freedesktop/portal/desktop/request/1_234/tok");
});

test("detectBackend", () => {
  assert.equal(detectBackend({ DISPLAY: ":0" }), "x11");
  assert.equal(detectBackend({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "KDE", KDE_FULL_SESSION: "true" }), "x11");
  assert.equal(detectBackend({ WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }), "gnome");
  assert.equal(detectBackend({ WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" }), "kde");
  assert.equal(detectBackend({ WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/sway.sock" }), "sway");
  assert.equal(detectBackend({ WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "x" }), "hyprland");
  assert.equal(detectBackend({ WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "COSMIC" }), "wayland");
  assert.equal(detectBackend({ WAYLAND_DISPLAY: "wayland-1", VISIONCLI_DESKTOP: "sway" }), "sway");
});
