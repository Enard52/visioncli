#!/bin/sh
# Installs the desktop tools VisionCLI uses for your distro and session, then sets up input access (Wayland).
#   sh install-deps.sh [-y] [--dry-run] [--session x11|gnome|kde|wlroots|hyprland]
# Package managers: apt, dnf/yum, pacman, zypper, apk, xbps, eopkg, emerge. Asks before anything runs with sudo.
# Shipped in the app as resources/bin/install-deps.sh (/opt/VisionCLI/resources/bin/install-deps.sh for the .deb).
set -u

YES=0 DRY=0 SESSION=
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    -n|--dry-run) DRY=1 ;;
    --session) SESSION=${2:-}; shift ;;
    --session=*) SESSION=${1#*=} ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
ask() { # ask "question" → 0 for yes (default yes; -y answers yes; no terminal answers no)
  [ "$YES" = 1 ] && return 0
  [ -r /dev/tty ] || return 1
  printf '%s [Y/n] ' "$1"
  read -r a </dev/tty || return 1
  case "$a" in [nN]*) return 1 ;; *) return 0 ;; esac
}
SUDO=
if [ "$(id -u)" != 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO=sudo
  elif command -v doas >/dev/null 2>&1; then SUDO=doas
  elif [ "$DRY" = 1 ]; then SUDO=sudo
  else say "Neither sudo nor doas found: run this as root."; exit 1; fi
fi
run() { # run as root (or just print with --dry-run)
  if [ "$DRY" = 1 ]; then say "  would run: $SUDO $*"; return 0; fi
  $SUDO "$@"
}

# --- Package manager --------------------------------------------------------------------------------------------
PM=
for c in apt-get dnf yum pacman zypper apk xbps-install eopkg emerge; do
  if command -v "$c" >/dev/null 2>&1; then PM=$c; break; fi
done
[ -n "$PM" ] || { say "No supported package manager found (apt, dnf, pacman, zypper, apk, xbps, eopkg, emerge)."; exit 1; }
[ "$PM" = yum ] && PM=dnf_yum

# --- Session ----------------------------------------------------------------------------------------------------
if [ -z "$SESSION" ]; then
  desk=$(printf '%s:%s' "${XDG_CURRENT_DESKTOP:-}" "${DESKTOP_SESSION:-}" | tr '[:upper:]' '[:lower:]')
  if [ "${XDG_SESSION_TYPE:-}" = wayland ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
    if [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then SESSION=hyprland
    else
      case "$desk" in
        *hyprland*) SESSION=hyprland ;;
        *gnome*|*ubuntu*|*unity*|*pop*|*budgie*) SESSION=gnome ;;
        *kde*|*plasma*) SESSION=kde ;;
        *) SESSION=wlroots ;; # sway, river, wayfire, labwc, niri, …
      esac
    fi
  else
    SESSION=x11
  fi
fi
case "$SESSION" in x11|gnome|kde|wlroots|hyprland) ;; *) say "unknown session: $SESSION"; exit 2 ;; esac

# Electron's prebuilt binaries need glibc.
if ldd --version 2>&1 | grep -qi musl; then
  say "Note: this system uses musl libc. VisionCLI's AppImage and .deb are built for glibc; they need a glibc"
  say "      environment (e.g. Void glibc, or a distrobox). The tools below are still useful for the MCP server."
fi

# --- Package names per manager ----------------------------------------------------------------------------------
# Roles: x11 (also used for XWayland windows), wayland (wlroots/Hyprland capture + clipboard), clip (Wayland
# clipboard everywhere), base (terminal, accessibility, notifications, speech), pw / pa (audio), fuse (AppImage).
pkgs() {
  case "$PM:$1" in
    apt-get:x11) echo "xdotool xinput wmctrl x11-utils maim imagemagick xclip" ;;
    apt-get:wayland) echo "grim slurp" ;;
    apt-get:clip) echo "wl-clipboard" ;;
    apt-get:base) echo "tmux at-spi2-core libnotify-bin python3-gi gir1.2-atspi-2.0 espeak-ng xdg-utils" ;;
    apt-get:pw) echo "pipewire-bin pulseaudio-utils" ;;
    apt-get:pa) echo "pulseaudio-utils" ;;
    apt-get:fuse) if apt-cache show libfuse2t64 >/dev/null 2>&1; then echo libfuse2t64; else echo libfuse2; fi ;;

    dnf*:x11) echo "xdotool xinput wmctrl xprop xwininfo maim ImageMagick xclip" ;;
    dnf*:wayland) echo "grim slurp" ;;
    dnf*:clip) echo "wl-clipboard" ;;
    dnf*:base) echo "tmux at-spi2-core libnotify python3-gobject espeak-ng xdg-utils" ;;
    dnf*:pw) echo "pipewire-utils pulseaudio-utils" ;;
    dnf*:pa) echo "pulseaudio-utils" ;;
    dnf*:fuse) echo "fuse-libs" ;;

    pacman:x11) echo "xdotool xorg-xinput wmctrl xorg-xprop xorg-xwininfo maim imagemagick xclip" ;;
    pacman:wayland) echo "grim slurp" ;;
    pacman:clip) echo "wl-clipboard" ;;
    pacman:base) echo "tmux at-spi2-core libnotify python-gobject espeak-ng xdg-utils" ;;
    pacman:pw) echo "pipewire libpulse" ;;
    pacman:pa) echo "libpulse" ;;
    pacman:fuse) echo "fuse2" ;;

    zypper:x11) echo "xdotool xinput wmctrl xprop xwininfo maim ImageMagick xclip" ;;
    zypper:wayland) echo "grim slurp" ;;
    zypper:clip) echo "wl-clipboard" ;;
    zypper:base) echo "tmux at-spi2-core libnotify-tools python3-gobject typelib-1_0-Atspi-2_0 espeak-ng xdg-utils" ;;
    zypper:pw) echo "pipewire-tools pulseaudio-utils" ;;
    zypper:pa) echo "pulseaudio-utils" ;;
    zypper:fuse) echo "libfuse2" ;;

    apk:x11) echo "xdotool xinput wmctrl xprop xwininfo maim imagemagick xclip" ;;
    apk:wayland) echo "grim slurp" ;;
    apk:clip) echo "wl-clipboard" ;;
    apk:base) echo "tmux at-spi2-core libnotify py3-gobject3 espeak-ng xdg-utils" ;;
    apk:pw) echo "pipewire-tools pulseaudio-utils" ;;
    apk:pa) echo "pulseaudio-utils" ;;
    apk:fuse) echo "fuse" ;;

    xbps-install:x11) echo "xdotool xinput wmctrl xprop xwininfo maim ImageMagick xclip" ;;
    xbps-install:wayland) echo "grim slurp" ;;
    xbps-install:clip) echo "wl-clipboard" ;;
    xbps-install:base) echo "tmux at-spi2-core libnotify python3-gobject espeak-ng xdg-utils" ;;
    xbps-install:pw) echo "pipewire pulseaudio-utils" ;;
    xbps-install:pa) echo "pulseaudio-utils" ;;
    xbps-install:fuse) echo "fuse" ;;

    eopkg:x11) echo "xdotool xinput wmctrl xprop xwininfo maim imagemagick xclip" ;;
    eopkg:wayland) echo "grim slurp" ;;
    eopkg:clip) echo "wl-clipboard" ;;
    eopkg:base) echo "tmux at-spi2-core libnotify python-gobject espeak-ng xdg-utils" ;;
    eopkg:pw) echo "pipewire pulseaudio" ;;
    eopkg:pa) echo "pulseaudio" ;;
    eopkg:fuse) echo "fuse2" ;;

    emerge:x11) echo "x11-misc/xdotool x11-misc/wmctrl x11-apps/xprop x11-apps/xwininfo media-gfx/maim media-gfx/imagemagick x11-misc/xclip" ;;
    emerge:wayland) echo "gui-apps/grim gui-apps/slurp" ;;
    emerge:clip) echo "gui-apps/wl-clipboard" ;;
    emerge:base) echo "app-misc/tmux app-accessibility/at-spi2-core x11-libs/libnotify dev-python/pygobject app-accessibility/espeak-ng x11-misc/xdg-utils" ;;
    emerge:pw) echo "media-video/pipewire media-libs/libpulse" ;;
    emerge:pa) echo "media-libs/libpulse" ;;
    emerge:fuse) echo "sys-fs/fuse:0" ;;
  esac
}

audio=pa
if pgrep -x pipewire >/dev/null 2>&1 || command -v pw-cli >/dev/null 2>&1; then audio=pw; fi
roles="base $audio x11 fuse"
case "$SESSION" in
  wlroots|hyprland) roles="$roles wayland clip" ;;
  gnome|kde) roles="$roles clip" ;;
esac
PKGS=
for r in $roles; do PKGS="$PKGS $(pkgs "$r")"; done
PKGS=$(echo $PKGS)

install_cmd() {
  case "$PM" in
    apt-get) echo "env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends" ;;
    dnf) echo "dnf install -y" ;;
    dnf_yum) echo "yum install -y" ;;
    pacman) echo "pacman -S --needed --noconfirm" ;;
    zypper) echo "zypper --non-interactive install" ;;
    apk) echo "apk add" ;;
    xbps-install) echo "xbps-install -Sy" ;;
    eopkg) echo "eopkg install -y" ;;
    emerge) echo "emerge --noreplace" ;;
  esac
}

say "VisionCLI dependencies"
say "  package manager: ${PM%_yum}"
say "  session:         $SESSION"
say "  packages:        $PKGS"
if ask "Install these with ${SUDO:-root}?"; then
  [ "$PM" = apt-get ] && run apt-get update -qq
  # shellcheck disable=SC2046
  if ! run $(install_cmd) $PKGS; then
    # One name unknown to this release shouldn't block the rest.
    say "Bulk install failed; installing one by one."
    missing=
    for p in $PKGS; do run $(install_cmd) "$p" >/dev/null 2>&1 || missing="$missing $p"; done
    [ -n "$missing" ] && say "Couldn't install:$missing (VisionCLI works without them, with less)"
  fi
else
  say "Skipped. To install later: $SUDO $(install_cmd) $PKGS"
fi

# --- Input access (Wayland) -------------------------------------------------------------------------------------
# Global hotkeys read /dev/input/event* (the input group); clicking and typing outside GNOME/KDE's portal write
# /dev/uinput (a udev rule gives the input group access). X11 uses XTest and XGrabKey and needs neither.
user=${SUDO_USER:-${USER:-$(id -un)}}
if [ "$SESSION" = x11 ]; then
  say "X11 session: no input-group setup needed."
else
  rule=/etc/udev/rules.d/60-visioncli-uinput.rules
  if ! id -nG "$user" | tr ' ' '\n' | grep -qx input || [ ! -e "$rule" ]; then
    say ""
    say "Wayland: VisionCLI needs \"$user\" in the input group (global hotkeys, typing and clicking via /dev/uinput)."
    if ask "Add $user to the input group and allow the group to use /dev/uinput?"; then
      getent group input >/dev/null 2>&1 || run groupadd -r input
      if [ "$PM" = apk ] && ! command -v usermod >/dev/null 2>&1; then run addgroup "$user" input
      else run usermod -aG input "$user"; fi
      if [ "$DRY" = 1 ]; then say "  would write $rule and load the uinput module"
      else
        printf '%s\n' 'KERNEL=="uinput", SUBSYSTEM=="misc", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' |
          $SUDO tee "$rule" >/dev/null
        echo uinput | $SUDO tee /etc/modules-load.d/visioncli-uinput.conf >/dev/null
        $SUDO modprobe uinput 2>/dev/null || true
        if command -v udevadm >/dev/null 2>&1; then
          $SUDO udevadm control --reload-rules 2>/dev/null
          $SUDO udevadm trigger --sysname-match=uinput 2>/dev/null
        fi
      fi
      say "Done. Log out and back in once so the new group applies."
    else
      say "Skipped. Later: $SUDO usermod -aG input $user  (then log out and back in)"
    fi
  else
    say "Input access: already set up."
  fi
fi
[ "$SESSION" = gnome ] && say "GNOME: VisionCLI asks once to enable its GNOME Shell extension (window list and capture on Wayland)."
[ "$SESSION" = kde ] && say "KDE: VisionCLI loads a small KWin script for the window list; nothing to do here."
exit 0
