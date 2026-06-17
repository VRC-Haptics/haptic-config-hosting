#!/usr/bin/env bash

# Restores the /var/www/haptic directory from a zip without touching root site files.
# Skips the nested 'site' directory if present in the archive.

set -euo pipefail

ZIP="${1:?Usage: restore.sh <archive.zip> [output-dir]}"
OUT="${2:-/var/www/haptic}"          # output dir (default: web root)
EXCLUDE_DIR="site"                   # subdirectory to skip

[[ -f "$ZIP" ]] || { echo "Error: archive '$ZIP' not found." >&2; exit 1; }
ZIP="$(realpath "$ZIP")"
mkdir -p "$OUT"; OUT="$(realpath "$OUT")"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP" -d "$TMP"

# catalog.json is the ONLY root file we write; everything else at root is left alone
[[ -f "$TMP/catalog.json" ]] && cp -f "$TMP/catalog.json" "$OUT/"

# restore every directory from the archive except the excluded one (replaces existing)
shopt -s nullglob
for d in "$TMP"/*/; do
  n=$(basename "$d")
  [[ "$n" == "$EXCLUDE_DIR" ]] && continue
  rm -rf "$OUT/$n"; cp -rf "$d" "$OUT/"
done
shopt -u nullglob

count=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d ! -name "$EXCLUDE_DIR" | wc -l)
echo "Restored catalog.json + $count dir(s) into $OUT — root files and '$EXCLUDE_DIR/' untouched."