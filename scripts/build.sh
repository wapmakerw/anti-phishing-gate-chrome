#!/bin/sh
#
# Package the extension into an installable, unpacked build + a zip suitable for
# "Load unpacked" and for uploading to the Chrome Web Store.
#
# There is no transpilation step — the source is plain MV3 JS/CSS/HTML — so
# "compiling" here means: validate (if node is available), copy the shipping
# files into dist/, and zip.
#
# POSIX sh — works whether invoked as `./scripts/build.sh`, `sh scripts/build.sh`,
# or `bash scripts/build.sh`.
#
# Usage:  ./scripts/build.sh
# Output: dist/sandbox-link-guard/            (unpacked, ready for Load unpacked)
#         dist/sandbox-link-guard-<version>.zip

set -eu

# Common install locations may be missing from a non-login / IDE shell's PATH
# (e.g. node installed under ~/.local/bin). Add them so tools are found.
PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export PATH

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DIST="$ROOT/dist"
NAME="sandbox-link-guard"
STAGE="$DIST/$NAME"

# Files/dirs that make up the shipping extension.
INCLUDE="manifest.json background.js lib content popup confirm icons"

# --- preflight ---------------------------------------------------------------
# zip is genuinely required to produce the artifact.
if ! command -v zip >/dev/null 2>&1; then
  echo "ERROR: 'zip' is required but was not found in PATH." >&2
  echo "       Install it (e.g. 'sudo apt-get install zip') and re-run." >&2
  exit 1
fi

# node is OPTIONAL — used only to validate sources. Missing node must not block
# packaging, so fall back to a node-less version read and skip validation.
HAVE_NODE=0
if command -v node >/dev/null 2>&1; then
  HAVE_NODE=1
fi

echo "==> Validating sources"
if [ "$HAVE_NODE" -eq 1 ]; then
  # Manifest must be valid JSON; read the version from it.
  VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")"
  # Syntax-check every JS file (paths here contain no spaces).
  for f in $(find lib content popup background.js -name '*.js'); do
    node --check "$f"
  done
  echo "    manifest valid, version $VERSION, JS OK"
else
  # Node-less version read: grab the first "version": "x.y.z" from the manifest.
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)"
  echo "    WARNING: 'node' not found — skipping JS/JSON validation."
  echo "    version $VERSION (read without node)"
fi

if [ -z "${VERSION:-}" ]; then
  echo "ERROR: could not determine version from manifest.json." >&2
  exit 1
fi

echo "==> Staging into $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
for item in $INCLUDE; do
  cp -R "$item" "$STAGE/"
done

# Ship only the rasterized icons, not the SVG source / generator script.
rm -f "$STAGE/icons/icon.svg" "$STAGE/icons/make-icons.sh"

ZIP="$DIST/$NAME-$VERSION.zip"
echo "==> Zipping $ZIP"
rm -f "$ZIP"
( cd "$STAGE" && zip -rq "$ZIP" . )

echo ""
echo "Build complete:"
echo "  Unpacked: $STAGE"
echo "  Zip:      $ZIP"
echo ""
echo "Load unpacked: chrome://extensions -> Developer mode -> Load unpacked -> select"
echo "  $STAGE"
