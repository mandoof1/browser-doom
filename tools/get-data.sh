#!/usr/bin/env bash
# Fetch a free IWAD. FreeDoom Phase 1 is the Ultimate Doom-compatible free WAD,
# so the port needs no commercial game files to be playable.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/data"
mkdir -p "$OUT"
if [ -f "$OUT/freedoom1.wad" ]; then echo "already have freedoom1.wad"; exit 0; fi
URL="https://github.com/freedoom/freedoom/releases/download/v0.12.1/freedoom-0.12.1.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -L -o "$TMP/freedoom.zip" "$URL"
unzip -q -o "$TMP/freedoom.zip" -d "$TMP"
cp "$TMP"/freedoom-*/freedoom1.wad "$OUT/freedoom1.wad"
cp "$TMP"/freedoom-*/freedoom-maps.wad "$OUT/" 2>/dev/null || true
ls -la "$OUT"
