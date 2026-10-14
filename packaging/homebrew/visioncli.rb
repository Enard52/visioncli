# Homebrew cask for the tap thethirdsourcers/homebrew-tap (Casks/visioncli.rb there). The release workflow's
# `homebrew` job writes this file into the tap with the new version and the .dmg's sha256 (packaging/homebrew/README.md).
#   brew install --cask thethirdsourcers/tap/visioncli
cask "visioncli" do
  version "0.10.4"
  sha256 :no_check # replaced by the release workflow with the .dmg's sha256

  url "https://github.com/thethirdsourcers/visioncli/releases/download/v#{version}/VisionCLI-#{version}-macos.dmg"
  name "VisionCLI"
  desc "Voice and screen co-assistant for developers, with Claude Code or Gemini"
  homepage "https://visioncli.thethirdsourcers.com"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself (and keeps its permissions); brew upgrade still works.
  auto_updates true
  depends_on macos: :ventura

  app "VisionCLI.app"

  uninstall launchctl: "dev.visioncli.overlay",
            quit:      "dev.visioncli.overlay"

  zap trash: [
    "~/Library/Application Support/visioncli",
    "~/Library/Caches/visioncli",
    "~/Library/LaunchAgents/dev.visioncli.overlay.plist",
    "~/Library/Logs/visioncli*",
    "~/Library/Preferences/dev.visioncli.overlay.plist",
  ]

  caveats <<~EOS
    VisionCLI is not notarized by Apple, so macOS blocks the first launch. Allow it once in
    System Settings > Privacy & Security > Open Anyway, or run:
      xattr -dr com.apple.quarantine /Applications/VisionCLI.app
  EOS
end
