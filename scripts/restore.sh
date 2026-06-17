#!/usr/bin/env bash

## Restores the /var/www/haptic directory from a zip file without touching site files.

set -euo pipefail

ZIP="${1:?Usage: restore.sh <archive.zip> [output-dir]}"
OUT="${2:-/var/www/haptic}"          # output dir (default: web root)

[[ -f "$ZIP" ]] || { echo "Error: archive '$ZIP' not found." >&2; exit 1; }
ZIP="$(realpath "$ZIP")"
mkdir -p "$OUT"; OUT="$(realpath "$OUT")"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP" -d "$TMP"

# catalog.json is the ONLY root file we write; everything else at root is left alone
[[ -f "$TMP/catalog.json" ]] && cp -f "$TMP/catalog.json" "$OUT/"

# restore every directory from the archive (merges into existing)
shopt -s nullglob
for d in "$TMP"/*/; do n=$(basename "$d"); rm -rf "$OUT/$n"; cp -rf "$d" "$OUT/"; done
shopt -u nullglob

count=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | wc -l)
echo "Restored catalog.json + $count dir(s) into $OUT — other root files untouched."