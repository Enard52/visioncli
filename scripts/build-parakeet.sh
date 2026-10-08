#!/bin/sh
# Builds the Parakeet speech-to-text helper (overlay/helpers/parakeet) into overlay/helpers/parakeet/.build/parakeet-server.
# FluidAudio is compiled straight in with swiftc (no SwiftPM, which is broken in some Command Line Tools installs).
# Apple Silicon only. Skips the 2-minute compile when the binary is newer than the helper's source.
set -e
cd "$(dirname "$0")/../overlay/helpers/parakeet"
[ "$(uname -m)" = "arm64" ] || { echo "Parakeet helper: Apple Silicon only, skipping."; exit 0; }
FLUIDAUDIO_COMMIT=0c0f113e8db4b862b19a99ce9fd7c9da73324f5f
OUT=.build/parakeet-server
if [ ! -d vendor/FluidAudio ]; then
  git clone -q https://github.com/FluidInference/FluidAudio.git vendor/FluidAudio
fi
if [ "$(git -C vendor/FluidAudio rev-parse HEAD)" != "$FLUIDAUDIO_COMMIT" ]; then
  git -C vendor/FluidAudio fetch -q --depth 1 origin "$FLUIDAUDIO_COMMIT" && git -C vendor/FluidAudio checkout -q "$FLUIDAUDIO_COMMIT"
  rm -f "$OUT"
fi
if [ -f "$OUT" ] && [ -z "$(find Sources -newer "$OUT" -name '*.swift')" ]; then echo "Parakeet helper up to date"; exit 0; fi

B=.build/obj
mkdir -p "$B"
FA=vendor/FluidAudio/Sources
clang -c -O2 "$FA/MachTaskSelfWrapper/MachTaskSelf.c" -I"$FA/MachTaskSelfWrapper/include" -o "$B/mts.o"
clang++ -std=c++17 -O2 -w -c "$FA/FastClusterWrapper/FastClusterWrapper.cpp" -I"$FA/FastClusterWrapper/include" -I"$FA/FastClusterWrapper" -o "$B/fc.o"
mkdir -p "$B/mts"
printf 'module MachTaskSelfWrapper {\n header "%s"\n export *\n}\n' "$PWD/$FA/MachTaskSelfWrapper/include/MachTaskSelf.h" > "$B/mts/module.modulemap"

build() { # extra swiftc args
  find "$FA/FluidAudio" Sources -name '*.swift' -print0 | xargs -0 swiftc -O -swift-version 5 -target arm64-apple-macos14.0 $1 \
    -module-name ParakeetServer -I "$B/mts" -I "$FA/FastClusterWrapper/include" "$B/mts.o" "$B/fc.o" -lc++ -o "$OUT"
}
echo "Building Parakeet helper (~2 min)…"
# Command Line Tools sometimes ship an SDK newer than their swiftc: fall back to older SDKs.
if ! build "" 2>/dev/null; then
  SDKDIR="$(dirname "$(xcrun --show-sdk-path)")"
  ok=
  for sdk in $(ls -d "$SDKDIR"/MacOSX[0-9]*.sdk 2>/dev/null | sort -rV); do
    if build "-sdk $sdk" 2>/dev/null; then ok=1; break; fi
  done
  [ -n "$ok" ] || build ""
fi
echo "Built $PWD/$OUT"
