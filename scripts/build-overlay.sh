#!/bin/sh
# Builds overlay/build/VisionCLI.app from overlay/Sources (macOS only).
#
# Local dev (default): this Mac's architecture, signed with the local identity if present (scripts/setup-signing.sh),
# installed into /Applications.
# Release (VISIONCLI_RELEASE=1): universal binary (arm64 + x86_64), MCP server + production deps bundled inside the
# app, ad-hoc signed, not installed. Used by scripts/package-release.sh and CI.
set -e
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || { echo "Voice overlay is macOS-only, skipping."; exit 0; }
command -v swiftc >/dev/null || { echo "swiftc not found: run xcode-select --install"; exit 1; }

RELEASE="${VISIONCLI_RELEASE:-}"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
APP=overlay/build/VisionCLI.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp overlay/Resources/AppIcon.icns overlay/Resources/kokoro_server.py "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.visioncli.overlay</string>
  <key>CFBundleName</key><string>VisionCLI</string>
  <key>CFBundleDisplayName</key><string>VisionCLI</string>
  <key>CFBundleExecutable</key><string>VisionCLI</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT License · github.com/thethirdsourcers/visioncli</string>
  <key>NSMicrophoneUsageDescription</key><string>VisionCLI listens while you hold Option+Space so you can ask Claude about your screen.</string>
  <key>NSAppleEventsUsageDescription</key><string>VisionCLI types your spoken questions into the Claude session in your terminal and controls the browser for quick commands.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>VisionCLI turns your spoken question into text for Claude.</string>
</dict>
</plist>
PLIST

# Compile for one architecture. Command Line Tools sometimes ship an SDK newer than their swiftc, so fall back
# to older SDKs until one works.
compile() { # arch out
  build() { swiftc -O -swift-version 5 -target "$1-apple-macos13.0" $3 overlay/Sources/*.swift -o "$2"; }
  if build "$1" "$2" "" 2>/dev/null; then return 0; fi
  SDKDIR="$(dirname "$(xcrun --show-sdk-path)")"
  for sdk in $(ls -d "$SDKDIR"/MacOSX[0-9]*.sdk 2>/dev/null | sort -rV); do
    if build "$1" "$2" "-sdk $sdk" 2>/dev/null; then echo "  $1: using $(basename "$sdk")"; return 0; fi
  done
  build "$1" "$2" "" # rerun to show the real errors
}

bundle_server() {
  # Bundle the MCP server so the app works without the repo (Node.js is still needed at runtime).
  [ -f dist/index.js ] || npx tsc
  SERVER="$APP/Contents/Resources/server"
  mkdir -p "$SERVER"
  cp -R dist "$SERVER/dist"
  cp package.json package-lock.json "$SERVER/"
  (cd "$SERVER" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
  rm -f "$SERVER/package-lock.json"
  echo "Bundled MCP server ($(du -sh "$SERVER" | cut -f1))"
}

if [ -n "$RELEASE" ]; then
  TMP="$(mktemp -d)"
  compile arm64 "$TMP/VisionCLI-arm64"
  compile x86_64 "$TMP/VisionCLI-x86_64"
  lipo -create "$TMP/VisionCLI-arm64" "$TMP/VisionCLI-x86_64" -output "$APP/Contents/MacOS/VisionCLI"
  rm -rf "$TMP"
  echo "Universal binary: $(lipo -archs "$APP/Contents/MacOS/VisionCLI")"
  bundle_server
else
  compile "$(uname -m)" "$APP/Contents/MacOS/VisionCLI"
  # VISIONCLI_BUNDLE_SERVER=1: also bundle the server in a local build (to test the downloaded-app experience).
  [ "${VISIONCLI_BUNDLE_SERVER:-}" = "1" ] && bundle_server
fi

# Signing: releases are ad-hoc (no Apple Developer ID). Local builds prefer the stable local identity
# (scripts/setup-signing.sh) so macOS keeps permissions across rebuilds.
if [ -z "$RELEASE" ] && security find-certificate -c "VisionCLI Local Signing" >/dev/null 2>&1 && \
   codesign --force --deep --sign "VisionCLI Local Signing" "$APP" 2>/dev/null; then
  echo "Signed with VisionCLI Local Signing"
else
  codesign --force --deep --sign - "$APP" >/dev/null
  echo "Ad-hoc signed"
fi
echo "Built $APP ($VERSION)"

# Local builds: install into /Applications (replacing the old copy).
if [ -z "$RELEASE" ] && [ "${VISIONCLI_NO_INSTALL:-}" != "1" ]; then
  rm -rf /Applications/VisionCLI.app
  ditto "$APP" /Applications/VisionCLI.app
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/VisionCLI.app 2>/dev/null || true
  echo "Installed /Applications/VisionCLI.app"
fi
