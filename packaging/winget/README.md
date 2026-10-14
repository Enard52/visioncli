# VisionCLI on winget

Package `TheThirdSourcers.VisionCLI`: the per-user NSIS installers (`VisionCLI-<version>-windows-{x64,arm64}.exe`)
from the GitHub release. Manifests here use schema 1.6.0. Users install with:

```powershell
winget install TheThirdSourcers.VisionCLI
```

## First version (by hand, once)

The release workflow's `winget` job (`vedantmgoyal9/winget-releaser`) only updates a package that already exists in
https://github.com/microsoft/winget-pkgs, so the first version goes in as a pull request:

1. Fill `InstallerSha256` for both installers from the release's `SHA256SUMS.txt` (and the version/URLs if newer).
2. Check them on a Windows machine:
   ```powershell
   winget validate --manifest packaging\winget
   winget settings --enable LocalManifestFiles   # once, as admin
   winget install --manifest packaging\winget
   ```
3. Submit: `wingetcreate submit packaging\winget --token <a GitHub token>` (https://github.com/microsoft/winget-create),
   or fork winget-pkgs and add the three files under `manifests/t/TheThirdSourcers/VisionCLI/<version>/`.
4. Sign the Microsoft CLA when the bot asks; a moderator merges after the automated validation (installs it in a VM).

Unsigned installers are accepted, but Microsoft's validation and SmartScreen treat a signed one better: SignPath
(`packaging/windows/SIGNPATH.md`) helps here too.

## Every later version (automatic)

1. Create a classic GitHub personal access token with the `public_repo` scope (the action forks winget-pkgs into the
   token's account and opens the pull request from there).
2. `gh secret set WINGET_TOKEN -R thethirdsourcers/visioncli` and paste it.
3. Each `v*` release then opens the winget-pkgs pull request for the new version (`installers-regex:
   'windows-(x64|arm64)\.exe$'`). Without the secret, the job prints a notice and stops.
