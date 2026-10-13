#!/bin/bash
# Usage: bundle harness.ts next to a build (build/harness.js), install the Linux Electron into $W/ui-overlay/electron-linux, then
#   docker run --rm --shm-size=1g -v <repo>:/repo:ro -v $W:/w vcli-linux2 bash /w/ui-overlay/docker.sh   (sway.sh: as a non-root user)
# Docker's default 64 MB /dev/shm is too small for several full-screen transparent windows (renderer SIGTRAP).
# Visual check of the overlay UI: Xvfb + openbox + xcompmgr (for transparency), a few windows to float over.
set -e
apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xcompmgr x11-apps xterm x11-xserver-utils >/dev/null 2>&1 || true
export DISPLAY=:99
Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 & sleep 1
openbox >/dev/null 2>&1 & sleep 0.5
${COMPOSITOR:-xcompmgr} >/dev/null 2>&1 & sleep 0.5
xsetroot -solid "#2d3a4f"
xterm -geometry 110x34+10+10 -bg "#1e1e1e" -fg "#d4d4d4" -e bash -c 'cat /repo/src/server.ts 2>/dev/null | head -60; sleep 600' >/dev/null 2>&1 &
xclock -geometry 400x400+700+100 >/dev/null 2>&1 &
sleep 1.5
mkdir -p /w/ui-shots
cd /w/build-ui-overlay
VCLI_OVERLAY_WINDOW_TYPE=${WTYPE-toolbar} VISIONCLI_DEBUG=1 SCENES=$SCENES SHOTS=/w/ui-shots XDG_CONFIG_HOME=/tmp/cfg HOME=/tmp/home timeout 180 /w/ui-overlay/electron-linux/node_modules/electron/dist/electron --no-sandbox /w/build-ui-overlay/harness.js 2>&1 | grep -v -E "dbus|Fontconfig|libva|viz_main|gpu_init|ERROR:bus|Gtk-Message" | head -80
