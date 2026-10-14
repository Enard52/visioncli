# VisionCLI in the Microsoft Store (MSIX)

The Store installs and updates the app itself, and Microsoft signs the package, so Store users never see
SmartScreen. Registering as an individual developer in Partner Center is free (https://storedeveloper.microsoft.com).
The release workflow builds an `.msix` per arch only when the identity variables below exist; otherwise it prints a
notice and builds nothing extra.

## The owner's steps (once)

1. Open a Partner Center developer account (individual: free; the publisher display name must be what you want
   shown, e.g. "Third Sourcers").
2. Reserve the app name **VisionCLI** (Apps and games → New product → MSIX or PWA app).
3. Product identity (Product management → Product identity) gives three values. Set them as repository variables:
   ```sh
   gh variable set MS_STORE_IDENTITY_NAME -R thethirdsourcers/visioncli --body "<Package/Identity/Name>"
   gh variable set MS_STORE_PUBLISHER -R thethirdsourcers/visioncli --body "CN=<Package/Identity/Publisher>"
   gh variable set MS_STORE_PUBLISHER_DISPLAY_NAME -R thethirdsourcers/visioncli --body "Third Sourcers"
   ```
4. The next `v*` release attaches `msix-x64` and `msix-arm64` to the workflow run (not to the GitHub release: an
   unsigned MSIX can't be installed outside the Store). Download them and upload both in a Store submission
   (Packages); fill in the listing, age rating and privacy policy URL, and declare the **runFullTrust** restricted
   capability (every desktop app packaged this way has it) with a short justification: "Desktop app (Electron)".
5. Certification takes from hours to a few days. Later versions: upload the new packages in a new submission (or
   automate it with the Microsoft Store Developer CLI, `msstore publish`, once the first submission is through).

Locally (Windows): `pwsh app/scripts/package-release-win.ps1 -Stage unpacked`, then with the three variables set,
`pwsh app/scripts/package-release-win.ps1 -Stage store` → `release/VisionCLI-<version>-windows-<arch>.msix`.

## What differs in the MSIX build, precisely

Electron reports it through `process.windowsStore`. The package runs with an identity and Windows virtualizes some of
what a normal install writes, so:

| | NSIS installer | Store (MSIX) |
| --- | --- | --- |
| Install location | `%LOCALAPPDATA%\Programs\VisionCLI` | `C:\Program Files\WindowsApps\<package>` (read-only) |
| Updates | the app's own updater (downloads the next installer) | the Store; the in-app updater should stay off for it |
| Start at Login | `HKCU\...\CurrentVersion\Run` value `VisionCLI` via `reg.exe` | the package's `windows.startupTask` (`VisionCLIStartup`, declared in `app/resources/win/appx-extensions.xml`, off by default); the switch calls the WinRT `StartupTask` API through PowerShell (`features/autostart.ts`). If the user turned it off in Settings → Apps → Startup, only they can turn it back on, and the app says so. A Run key written from inside the package is virtualized and Windows would never read it. |
| `visioncli://` links | `HKCU\Software\Classes\visioncli` (installer + `setAsDefaultProtocolClient`) | `uap:Protocol` in the manifest; `setAsDefaultProtocolClient` is skipped (`index.ts`), its registry write would be virtualized |
| Settings, logs, models | `%APPDATA%\visioncli`, `%LOCALAPPDATA%\visioncli` | the same paths as the app sees them, but new files there are redirected to `%LOCALAPPDATA%\Packages\<package family>\LocalCache\{Roaming,Local}\visioncli`. Processes started by the app (claude, the MCP server it runs) share that view; programs started outside the package do not. Uninstalling the package deletes them. |
| MCP wrapper | `%LOCALAPPDATA%\visioncli\bin\visioncli-mcp.cmd`, registered with `claude mcp add` | written to the same path, so it lands in the package's private copy: Claude Code started by VisionCLI finds it, but a `claude` you start yourself in a terminal does not see it or the app's settings. For using VisionCLI's MCP tools from your own terminals, install the NSIS build instead (both can't be installed together usefully). |
| Tiles and icons | `resources/win/icon.ico` | `app/resources/appx/*.png` (generated from `docs/logo.png`; replace with designed tiles before the first submission) |

Not changed: the `dev.visioncli.overlay` AppUserModelID (notifications), the hotkeys, the helper `vcli-win.exe`, and
everything the app does on screen.
