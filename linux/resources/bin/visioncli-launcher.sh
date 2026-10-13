#!/bin/sh
# Installed by scripts/after-pack.cjs as the app's executable (`visioncli`); the Electron binary sits next to it
# as `visioncli.bin`. AppRun, /usr/bin/visioncli and the .desktop entry all start this.
#
# Chromium's sandbox stays on whenever it can work: unprivileged user namespaces, or a setuid-root chrome-sandbox
# (the .deb sets that). Only when neither works (an AppImage on Ubuntu 24.04+, where AppArmor restricts namespaces,
# a hardened kernel, a container) does it add --no-sandbox, which electron-builder's AppImage entry always passes.
here=$(dirname "$(readlink -f "$0")")
bin="$here/visioncli.bin"

# Node mode (the MCP server via visioncli-mcp): no Chromium, and Node rejects Chromium switches.
[ -n "$ELECTRON_RUN_AS_NODE" ] && exec "$bin" "$@"

# Drop the desktop entry's marker argument (see appImage.executableArgs in electron-builder.yml).
n=$#
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  [ "$a" = --vcli-desktop ] || set -- "$@" "$a"
done

userns_ok() {
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ] && return 1
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = 0 ] && return 1
  # Ubuntu's AppArmor restriction: only binaries with a "userns" profile (the .deb installs one) may use them.
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
    grep -qs "$bin" /etc/apparmor.d/visioncli
    return
  fi
  # Seccomp (containers) and other locks: try it. Without unshare, assume the common case (allowed).
  command -v unshare >/dev/null 2>&1 || return 0
  unshare -Ur true >/dev/null 2>&1
}

sandbox_ok() {
  # Tests force the answer.
  case "$VISIONCLI_SANDBOX_CHECK" in yes) return 0 ;; no) return 1 ;; esac
  userns_ok && return 0
  # The setuid-root helper (the .deb's chrome-sandbox) still needs namespaces, which containers deny even to root.
  [ -e /.dockerenv ] || [ -e /run/.containerenv ] && return 1
  [ -u "$here/chrome-sandbox" ] && [ "$(stat -c %u "$here/chrome-sandbox" 2>/dev/null)" = 0 ]
}

if [ -z "$VISIONCLI_NO_SANDBOX" ] && sandbox_ok; then
  exec "$bin" "$@"
fi
echo "visioncli: Chromium's sandbox is unavailable here (user namespaces are blocked); starting with --no-sandbox." >&2
exec "$bin" --no-sandbox "$@"
