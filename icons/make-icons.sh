#!/bin/sh
#
# Generate PNG extension icons from the master SVG file.
#
# Usage: ./icons/make-icons.sh

set -eu

PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

MAGICK="magick"
command -v "$MAGICK" >/dev/null 2>&1 || MAGICK="convert"

echo "==> Rendering PNG icons from icon.svg"

for s in 128 48 32 16; do
  $MAGICK -background none icon.svg -resize ${s}x${s} icon-${s}.png
done

echo "Generated: $(ls icon-128.png icon-48.png icon-32.png icon-16.png)"
