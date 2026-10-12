#!/bin/sh
# Builds the downloadable release: release/VisionCLI-<version>-macos.dmg and .zip, plus SHA256SUMS.txt.
# Universal (Apple Silicon + Intel), MCP server bundled, ad-hoc signed.
set -e
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
OUT=release
rm -rf "$OUT"
mkdir -p "$OUT"

npm ci --no-audit --no-fund --loglevel=error
npm run bundle
VISIONCLI_RELEASE=1 sh scripts/build-overlay.sh

APP=overlay/build/VisionCLI.app
ZIP="$OUT/VisionCLI-$VERSION-macos.zip"
DMG="$OUT/VisionCLI-$VERSION-macos.dmg"

ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/VisionCLI.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "VisionCLI $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

(cd "$OUT" && shasum -a 256 *.dmg *.zip > SHA256SUMS.txt)
echo "Release files:"
ls -lh "$OUT"
