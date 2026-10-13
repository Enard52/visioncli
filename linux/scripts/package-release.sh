#!/bin/sh
# Builds the Linux release for one arch: release/VisionCLI-<version>-linux-{x86_64,arm64}.AppImage and
# VisionCLI-<version>-linux-{amd64,arm64}.deb. The version is the repo's (package.json at the root), so a tag
# only needs the root bump.
#   sh linux/scripts/package-release.sh [x64|arm64]     (default: this machine's arch)
set -e
cd "$(dirname "$0")/../.."
VERSION="$(node -p "require('./package.json').version")"
ARCH="${1:-$(node -p 'process.arch')}"
OUT=release
mkdir -p "$OUT"

npm ci --no-audit --no-fund --loglevel=error # the MCP server bundle (build/server) comes from ../src
cd linux
npm ci --no-audit --no-fund --loglevel=error
npm pkg set version="$VERSION" # no-op when linux/package.json already matches
node build.mjs
# electron-builder's bundled fpm (for the .deb) is x86_64 only.
if [ "$(uname -m)" != x86_64 ] && command -v fpm >/dev/null 2>&1; then export USE_SYSTEM_FPM=true; fi
npx electron-builder --linux AppImage deb "--$ARCH" --publish never
cp dist/VisionCLI-"$VERSION"-linux-*.AppImage dist/VisionCLI-"$VERSION"-linux-*.deb "../$OUT/"
cd ..
echo "Release files:"
ls -lh "$OUT"
