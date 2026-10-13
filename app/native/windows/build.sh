#!/bin/sh
# Builds vcli-win.exe (C#, .NET Framework 4.8) and copies it to app/resources/bin/, where electron-builder packs it.
# Works on macOS/Linux/Windows with the .NET SDK (8+): the net48 reference assemblies come from NuGet at build time.
#   sh app/native/windows/build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dotnet build "$here/vcli-win.csproj" -c Release -nologo -v quiet
mkdir -p "$here/../../resources/bin"
cp "$here/bin/Release/net48/vcli-win.exe" "$here/../../resources/bin/vcli-win.exe"
echo "built $(cd "$here/../../resources/bin" && pwd)/vcli-win.exe"
