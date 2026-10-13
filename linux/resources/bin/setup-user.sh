#!/bin/sh
# Per-user setup the packaged app runs on every start (quick and idempotent; no root):
#   sh "$RESOURCES/bin/setup-user.sh"   (inherits $APPIMAGE when running as an AppImage)
# 1. AppImage: ~/.local/bin/VisionCLI.AppImage → $APPIMAGE (the file moves with updates; this link doesn't),
#    plus a menu entry and icon, since an AppImage installs nothing by itself.
# 2. ~/.local/bin/visioncli-mcp: runs the bundled MCP server with the app's Electron as Node (see that file).
# 3. ~/.config/systemd/user/visioncli.service (crash restart, optional start at login), if systemd runs.
# 4. Once: registers visioncli-mcp with Claude Code / Antigravity (`visioncli-mcp install`), if `claude` exists.
# Prints one "key=value" line per result for the app's log.
set -u
res=$(dirname "$(dirname "$(readlink -f "$0")")")
bindir="$HOME/.local/bin"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$bindir"

if [ -n "${APPIMAGE:-}" ] && [ -f "$APPIMAGE" ]; then
  exe="$bindir/VisionCLI.AppImage"
  [ "$(readlink "$exe" 2>/dev/null)" = "$APPIMAGE" ] || ln -sfn "$APPIMAGE" "$exe"
  echo "appimage=$exe"
  mkdir -p "$data/applications"
  for size in 16 24 32 48 64 128 256; do
    d="$data/icons/hicolor/${size}x${size}/apps"
    [ -f "$d/visioncli.png" ] || { mkdir -p "$d" && cp "$res/icons/${size}x${size}.png" "$d/visioncli.png"; }
  done
  desktop="$data/applications/visioncli.desktop"
  sed "s|@EXEC@|$exe|" "$res/visioncli.desktop" > "$desktop.tmp" && mv "$desktop.tmp" "$desktop"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data/applications" >/dev/null 2>&1
else
  # .deb (or an unpacked tarball): the launcher next to resources/.
  exe="$(dirname "$res")/visioncli"
fi

if ! cmp -s "$res/bin/visioncli-mcp" "$bindir/visioncli-mcp"; then
  cp "$res/bin/visioncli-mcp" "$bindir/visioncli-mcp.tmp" && chmod 755 "$bindir/visioncli-mcp.tmp" &&
    mv "$bindir/visioncli-mcp.tmp" "$bindir/visioncli-mcp"
fi
echo "mcp=$bindir/visioncli-mcp"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  unit="$config/systemd/user/visioncli.service"
  mkdir -p "$(dirname "$unit")"
  sed "s|@EXEC@|$exe|" "$res/systemd/visioncli.service" > "$unit.tmp"
  if cmp -s "$unit.tmp" "$unit"; then rm -f "$unit.tmp"; else mv "$unit.tmp" "$unit" && systemctl --user daemon-reload; fi
  echo "unit=$unit"
fi

marker="$config/visioncli/.mcp-registered"
if [ ! -e "$marker" ]; then
  claude=$(command -v claude || true)
  for c in "$bindir/claude" "$HOME/.claude/local/claude" "$HOME/.npm-global/bin/claude"; do
    [ -z "$claude" ] && [ -x "$c" ] && claude=$c
  done
  if [ -n "$claude" ]; then
    mkdir -p "$(dirname "$marker")"
    VISIONCLI_CLAUDE="$claude" PATH="$bindir:$PATH" "$bindir/visioncli-mcp" install >/dev/null 2>&1 && touch "$marker" && echo "registered=$claude"
  fi
fi
exit 0
