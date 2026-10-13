#!/bin/bash
# Usage: bundle harness.ts next to a build (build/harness.js), install the Linux Electron into $W/ui-overlay/electron-linux, then
#   docker run --rm --shm-size=1g -v <repo>:/repo:ro -v $W:/w vcli-linux2 bash /w/ui-overlay/sway.sh   (sway.sh: as a non-root user)
# Docker's default 64 MB /dev/shm is too small for several full-screen transparent windows (renderer SIGTRAP).
# The overlay under Sway (wlroots) via XWayland: are override-redirect windows placed and kept above native Wayland windows?
export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p $XDG_RUNTIME_DIR; chmod 700 $XDG_RUNTIME_DIR
mkdir -p /tmp/sway; cat > /tmp/sway/config <<'CFG'
xwayland enable
output HEADLESS-1 resolution 1440x900 bg #2d3a4f solid_color
default_border none
CFG
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman sway -c /tmp/sway/config >/tmp/sway.log 2>&1 &
sleep 2
export WAYLAND_DISPLAY=$(ls $XDG_RUNTIME_DIR | grep -m1 '^wayland-[0-9]*$')
export SWAYSOCK=$(ls $XDG_RUNTIME_DIR/sway-ipc.* 2>/dev/null | head -1)
echo "wayland=$WAYLAND_DISPLAY sock=$SWAYSOCK"
# A native Wayland app filling the screen (tiled), then make it fullscreen for the hard case.
GDK_BACKEND=wayland gedit /repo/README.md >/dev/null 2>&1 &
sleep 3
swaymsg -t get_tree | grep -o '"app_id": "[^"]*"' | head
sleep 1
export DISPLAY=$(ls /tmp/.X11-unix | sed 's/X/:/' | head -1)
echo "xwayland DISPLAY=$DISPLAY"
cd /w/build-ui-overlay
export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=sway SHOT_CMD=grim VISIONCLI_DEBUG=1 SHOTS=/w/ui-shots HOME=/tmp/home
SHOT_PREFIX=sway- SCENES=answer,marks,mascot-peek \
  timeout 120 /w/ui-overlay/electron-linux/node_modules/electron/dist/electron --no-sandbox /w/build-ui-overlay/harness.js 2>&1 | grep -E "shot|overlay:|Override"
# The hard case: a full-screen native app.
swaymsg '[app_id="gedit"] fullscreen enable' >/dev/null; sleep 1
SHOT_PREFIX=sway-fullscreen- SCENES=answer timeout 60 /w/ui-overlay/electron-linux/node_modules/electron/dist/electron --no-sandbox /w/build-ui-overlay/harness.js 2>&1 | grep -E "shot"
pkill gedit; swaymsg exit >/dev/null 2>&1; exit 0
