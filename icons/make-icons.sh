#!/bin/sh
#
# Generate the extension icons from scratch with ImageMagick (its built-in SVG
# renderer doesn't honour gradients, so we compose the artwork natively).
#
# Theme: a gradient security shield (trust/protection) with a white fish-hook
# emblem (phishing). Renders a 128px master, then downscales to 48/32/16.
#
# Usage: ./icons/make-icons.sh   (run from the repo root or the icons dir)

set -eu

PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

MAGICK="magick"
command -v "$MAGICK" >/dev/null 2>&1 || MAGICK="convert"

SHIELD="path 'M64 14 L106 28 L106 62 C106 91 87 110 64 118 C41 110 22 91 22 62 L22 28 Z'"
GLOSS="path 'M30 33 L98 33 L98 58 C84 68 44 68 30 58 Z'"
HOOK="path 'M64 49 L64 80 C64 95 46 98 41 84 C38 77 44 72 50 75'"

# 1) Vertical gradient (indigo -> blue -> cyan).
$MAGICK -size 128x128 gradient:'#4f46e5'-'#06b6d4' _grad.png

# 2) Shield-shaped alpha mask.
$MAGICK -size 128x128 xc:black -fill white -draw "$SHIELD" _mask.png

# 3) Clip the gradient to the shield.
$MAGICK _grad.png _mask.png -alpha off -compose CopyOpacity -composite _shield.png

# 4) Top gloss highlight (kept inside the shield bounds).
$MAGICK -size 128x128 xc:none -fill 'rgba(255,255,255,0.32)' -draw "$GLOSS" _gloss.png

# 5) Compose: shield + gloss + subtle rim, then the white hook on top.
$MAGICK _shield.png _gloss.png -compose over -composite \
  -fill none -stroke 'rgba(255,255,255,0.18)' -strokewidth 2 -draw "$SHIELD" \
  -stroke white -strokewidth 11 -draw "stroke-linecap round stroke-linejoin round $HOOK" \
  -strokewidth 9 -draw "circle 64,38 64,30" \
  icon-128.png

# 6) Downscale the master to the remaining sizes.
for s in 48 32 16; do
  $MAGICK icon-128.png -filter Lanczos -resize ${s}x${s} icon-${s}.png
done

rm -f _grad.png _mask.png _shield.png _gloss.png
echo "Generated: $(ls icon-128.png icon-48.png icon-32.png icon-16.png)"
