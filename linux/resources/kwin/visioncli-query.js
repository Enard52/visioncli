// VisionCLI ↔ KWin (Plasma 5.27 and 6). KDE on Wayland doesn't let apps list windows or read the pointer, but KWin
// runs scripts: VisionCLI fills in REQUEST, loads this file through org.kde.kwin.Scripting (loadScript + run), and
// the script answers by calling back into VisionCLI's own D-Bus service with callDBus, then gets unloaded.
//
//   REQUEST.action "snapshot": windows (front-most first), the active one, the cursor and the screens
//   REQUEST.action "activate": focus the window whose id is REQUEST.target

const REQUEST = /*REQUEST*/{ "token": "", "action": "snapshot", "target": "", "service": "", "path": "/dev/visioncli/KWinBridge", "iface": "dev.visioncli.KWinBridge" }/*END*/;

function rect(g) {
    return { x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.width), height: Math.round(g.height) };
}

// Plasma 6: activeWindow / windowList(); Plasma 5: activeClient / clientList().
function activeWin() {
    return workspace.activeWindow !== undefined ? workspace.activeWindow : workspace.activeClient;
}

// Bottom → top when the stacking order is available, else whatever order KWin keeps.
function allWindows() {
    if (workspace.stackingOrder) return workspace.stackingOrder;
    if (workspace.windowList) return workspace.windowList();
    return workspace.clientList();
}

function idOf(w) {
    return String(w.internalId || w.windowId);
}

function onCurrentDesktop(w) {
    if (w.onAllDesktops) return true;
    const cur = workspace.currentDesktop;
    if (w.desktops && typeof cur === "object") {
        for (let i = 0; i < w.desktops.length; i++) {
            const d = w.desktops[i];
            if (d === cur || (d && cur && d.id === cur.id)) return true;
        }
        return false;
    }
    return w.desktop === cur;
}

function onCurrentActivity(w) {
    if (!w.activities || w.activities.length === 0 || !workspace.currentActivity) return true;
    return w.activities.indexOf(workspace.currentActivity) >= 0;
}

function visible(w) {
    return w && !w.deleted && !w.minimized && (w.normalWindow || w.dialog) && onCurrentDesktop(w) && onCurrentActivity(w);
}

function screens() {
    if (workspace.screens) {
        const out = [];
        for (let i = 0; i < workspace.screens.length; i++) out.push(rect(workspace.screens[i].geometry));
        return out;
    }
    const out = [];
    for (let i = 0; i < workspace.numScreens; i++) out.push(rect(workspace.clientArea(KWin.ScreenArea, i, workspace.currentDesktop)));
    return out;
}

function snapshot() {
    const active = activeWin();
    const list = allWindows();
    const windows = [];
    for (let i = list.length - 1; i >= 0; i--) {
        const w = list[i];
        if (!visible(w)) continue;
        windows.push({
            id: idOf(w),
            resourceClass: String(w.resourceClass || ""),
            resourceName: String(w.resourceName || ""),
            desktopFile: String(w.desktopFileName || ""),
            caption: String(w.caption || ""),
            pid: w.pid || 0,
            rect: rect(w.frameGeometry || w.geometry),
            active: w === active,
        });
    }
    // Without a stacking order, at least put the active window first.
    if (!workspace.stackingOrder) windows.sort(function (a, b) { return (b.active ? 1 : 0) - (a.active ? 1 : 0); });
    const c = workspace.cursorPos;
    return {
        windows: windows,
        stacked: !!workspace.stackingOrder,
        cursor: c ? { x: Math.round(c.x), y: Math.round(c.y) } : null,
        screens: screens(),
    };
}

function activate(id) {
    const list = allWindows();
    for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (w && idOf(w) === id) {
            if (w.minimized) w.minimized = false;
            if (workspace.activeWindow !== undefined) workspace.activeWindow = w;
            else workspace.activeClient = w;
            return { ok: true };
        }
    }
    return { ok: false };
}

let result;
try {
    result = REQUEST.action === "activate" ? activate(REQUEST.target) : snapshot();
} catch (e) {
    result = { error: String(e) };
}
callDBus(REQUEST.service, REQUEST.path, REQUEST.iface, "Report", REQUEST.token, JSON.stringify(result));
