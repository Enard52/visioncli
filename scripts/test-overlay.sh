#!/bin/sh
# Runs the overlay's unit tests: the Foundation-only overlay/Sources/Core*.swift compiled with overlay/Tests/*.swift
# into a plain executable (SwiftPM/XCTest need full Xcode; this works with Command Line Tools alone).
set -e
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || { echo "Overlay tests are macOS-only, skipping."; exit 0; }
command -v swiftc >/dev/null || { echo "swiftc not found: run xcode-select --install"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/overlay-tests"

# Same SDK fallback as build-overlay.sh: Command Line Tools sometimes ship an SDK newer than their swiftc.
build() { swiftc -swift-version 5 -target "$(uname -m)-apple-macos13.0" $1 overlay/Sources/Core*.swift overlay/Tests/*.swift -o "$BIN"; }
compiled=""
if build "" 2>/dev/null; then compiled=1; else
  SDKDIR="$(dirname "$(xcrun --show-sdk-path)")"
  for sdk in $(ls -d "$SDKDIR"/MacOSX[0-9]*.sdk 2>/dev/null | sort -rV); do
    if build "-sdk $sdk" 2>/dev/null; then echo "using $(basename "$sdk")"; compiled=1; break; fi
  done
fi
[ -n "$compiled" ] || build "" # rerun to show the real errors

"$BIN"
