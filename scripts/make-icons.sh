#!/bin/sh
# Renders every icon from the masters in docs/brand (Chrome headless draws the SVGs; the wordmark uses Outfit from
# Google Fonts). Outputs: overlay/Resources/AppIcon.icns, app/resources/icons/*.png, app/resources/appx/*.png,
# app/resources/win/icon.ico, docs/logo.png and the README wordmarks.
#   sh scripts/make-icons.sh
set -e
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BRAND="$PWD/docs/brand"

# shot <html> <width> <height> <out.png>: a transparent-background screenshot of a page.
shot() {
  printf '%s' "$1" > "$TMP/page.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$2,$3" --virtual-time-budget=3000 --screenshot="$4" "file://$TMP/page.html" >/dev/null 2>&1
}
page() { # <body html>
  printf '<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;600&display=swap" rel="stylesheet"><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block}</style></head><body>%s</body></html>' "$1"
}
icon() { # <size> <out>: the full-bleed app icon
  shot "$(page "<img src=\"file://$BRAND/icon.svg\" width=$1 height=$1>")" "$1" "$1" "$2"
}

# Linux (hicolor), Windows (.ico) and the README logo: the full rounded square.
for s in 16 24 32 48 64 128 256 512; do icon $s "app/resources/icons/${s}x${s}.png"; done
cp app/resources/icons/256x256.png docs/logo.png

# macOS: Apple's grid puts the 824 px body in the middle of the 1024 px canvas.
mkdir -p "$TMP/AppIcon.iconset"
for s in 16 32 128 256 512; do
  for k in 1 2; do
    px=$((s * k)); body=$((px * 824 / 1024)); pad=$(((px - body) / 2))
    if [ $k = 2 ]; then name="icon_${s}x${s}@2x.png"; else name="icon_${s}x${s}.png"; fi
    shot "$(page "<div style=\"padding:${pad}px\"><img src=\"file://$BRAND/icon.svg\" width=$body height=$body></div>")" "$px" "$px" "$TMP/AppIcon.iconset/$name"
  done
done
iconutil -c icns "$TMP/AppIcon.iconset" -o overlay/Resources/AppIcon.icns

# Microsoft Store tiles.
icon 150 app/resources/appx/Square150x150Logo.png
icon 44 app/resources/appx/Square44x44Logo.png
icon 50 app/resources/appx/StoreLogo.png
shot "$(page "<div style=\"width:310px;height:150px;border-radius:24px;background:linear-gradient(135deg,#1E2560,#07081A);display:flex;align-items:center;justify-content:center;gap:12px\"><img src=\"file://$BRAND/mark.svg\" width=56 height=56><span style=\"font:300 34px Outfit;color:#fff\">Vision<b style=\"font-weight:600\">CLI</b></span></div>")" 310 150 app/resources/appx/Wide310x150Logo.png

# README wordmarks (light and dark themes).
wordmark() { # <mark svg> <text colour> <out>
  shot "$(page "<div style=\"display:flex;align-items:center;gap:22px;padding:10px 4px\"><img src=\"file://$BRAND/$1\" width=96 height=96><span style=\"font:300 72px Outfit;color:$2;letter-spacing:-1px\">Vision<b style=\"font-weight:600\">CLI</b></span></div>")" 520 116 "$3"
}
wordmark mark.svg "#1E2A6B" docs/brand/wordmark-light.png
wordmark mark.svg "#FFFFFF" docs/brand/wordmark-dark.png

node app/resources/win/make-ico.mjs
echo "Icons written."
