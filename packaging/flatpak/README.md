# VisionCLI on Flathub

App id `com.thethirdsourcers.VisionCLI`. The manifest repackages the release's unpacked Linux app
(`VisionCLI-<version>-linux-{x64,arm64}.tar.gz`, built by `app/scripts/package-release.sh`) on
`org.freedesktop.Platform` 24.08 with `org.electronjs.Electron2.BaseApp` (zypak gives Chromium its sandbox).

| File | What |
| --- | --- |
| `com.thethirdsourcers.VisionCLI.yml` | the manifest |
| `com.thethirdsourcers.VisionCLI.metainfo.xml` | AppStream: description, homepage, developer, releases, screenshots |
| `visioncli.sh` | `/app/bin/visioncli` and `/app/bin/visioncli-mcp` |

## Build and try it locally

```sh
flatpak install --user flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08
# Put the release's sha256s (SHA256SUMS.txt) into the two archive sources first.
flatpak-builder --user --install --force-clean build-dir com.thethirdsourcers.VisionCLI.yml
flatpak run com.thethirdsourcers.VisionCLI
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest com.thethirdsourcers.VisionCLI.yml
appstreamcli validate com.thethirdsourcers.VisionCLI.metainfo.xml
```

## Submitting (one time)

1. Replace the screenshot placeholders in the metainfo with real images (Flathub requires them; they can live in the
   site's `screenshots/` folder or in the repo).
2. Set the two `sha256` values to the current release's tarballs (from `SHA256SUMS.txt`) and its version in the URLs.
3. Fork https://github.com/flathub/flathub, branch from `new-pr`, add the manifest, `visioncli.sh` and the metainfo
   at the root, and open a pull request against `new-pr` titled "Add com.thethirdsourcers.VisionCLI"
   (https://docs.flathub.org/docs/for-app-authors/submission).
4. Answer the reviewers (permissions below). Once merged, Flathub creates `flathub/com.thethirdsourcers.VisionCLI`
   and invites you as a maintainer.
5. Verify the app id's domain so the store shows "Verified": Flathub's developer portal gives a token to publish at
   `https://thethirdsourcers.com/.well-known/org.flathub.VerifiedApps.txt`.
6. Updates: the `x-checker-data` entries let Flathub's external data checker open a pull request on each release
   (new URLs and sha256s); add a `<release>` to the metainfo each time.

## Permissions reviewers will question, and why

VisionCLI is a tool that looks at the whole screen, listens for a hotkey anywhere, and drives other apps and the
user's own command-line tools. Those are its function, so the sandbox is necessarily wide. Honestly:

- **`--talk-name=org.freedesktop.Flatpak`** (run commands on the host) is effectively a sandbox escape, and the one
  reviewers push back on most. VisionCLI's whole job is to run the user's `claude` / `agy` / `gemini` CLI (installed on
  the host, with the user's own sign-in), `tmux`, and desktop tools (`xdotool`, `wmctrl`, `maim`, `grim`, `pactl`…)
  that can't be bundled usefully: the CLIs must be the user's own installs, and the desktop tools act on the host
  session. Every such call goes through one helper (`src/flatpak.ts`), which runs only the app's own files inside.
  Flathub accepts this for IDEs and terminals (e.g. VS Code, GNOME Builder) with the same reasoning.
- **`--device=all`**: hold-to-talk reads the keyboard from `/dev/input` (the only way to see a held key on Wayland
  without focus), and computer control on Wayland writes to `/dev/uinput`. Both still need the user in the `input`
  group, as with the .deb.
- **`--filesystem=home`**: answers name the real file in the user's projects (`file:line`), the CLIs work in those
  projects, and the host's `~/.config/visioncli` is shared with the MCP server the CLIs start on the host.
- **`--talk-name=org.a11y.Bus`**: reading other apps' buttons and fields through AT-SPI for computer control.
- **`--talk-name=org.kde.KWin`** and **`--own-name=dev.visioncli.*`**: on KDE a KWin script, and on GNOME a Shell
  extension, report windows and the pointer back to the app on `dev.visioncli.*` names (these predate the Flatpak
  and are shared with the other packages, so they keep the old prefix rather than the app id).
- **`--socket=pulseaudio`**: the microphone and spoken answers. **`--share=network`**: the speech model downloads and
  the local speech servers on 127.0.0.1.

## How the app behaves inside Flatpak

- `/.flatpak-info` switches `src/flatpak.ts` on: host tools go through `flatpak-spawn --host` (with the variables the
  app set, e.g. PATH), helpers that live as long as the app add `--watch-bus` so they stop with it, and anything under
  `/app` (or the Electron binary itself) runs inside. Lookups (`which`) ask the host when the sandbox can't see a tool.
- `visioncli.sh` keeps `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` at the host's defaults, so settings and
  models are shared with the MCP server on the host and with a previous .deb/AppImage install, and points `TMPDIR`
  into `~/.var/app/com.thethirdsourcers.VisionCLI/cache/tmp`, a path both sides see (the sandbox's `/tmp` is private).
- The MCP server: the app copies `visioncli-mcp` to `~/.local/bin` as usual; on the host that script finds no
  AppImage or `/opt/VisionCLI` and runs `flatpak run --command=visioncli-mcp com.thethirdsourcers.VisionCLI`.
- Start at login writes the systemd user unit (or XDG autostart entry) in the host's `~/.config` with
  `flatpak run com.thethirdsourcers.VisionCLI` as the command.

Not yet routed through the helper (they run inside the sandbox and may not find the host's tools): the microphone
and playback tools in `app/src/main/audio`, espeak-ng/spd-say/piper in `app/src/main/tts/system.ts`, `xinput`/`xmodmap`
in `app/src/main/input`, and the terminal emulators in `app/src/main/assistant/terminal.ts`. Test these in the
Flatpak before submitting; each is a one-line `hostCommand(...)` change.
