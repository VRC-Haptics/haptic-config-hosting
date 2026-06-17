#!/usr/bin/env bash

# Creates an archive snapshot of the publicly published maps.
# Ignores all root files other than catalog.json, and the nested 'site' directory.

set -euo pipefail

SRC="${1:-/var/www/haptic}"          # source dir (default: web root)
OUT="${2:-$HOME/archive.zip}"        # output zip (default: ~/archive.zip)
OUT="$(realpath -m "$OUT")"
EXCLUDE_DIR="site"                   # subdirectory to skip

[[ -d "$SRC" ]]       || { echo "Error: source '$SRC' not found." >&2; exit 1; }
cd "$SRC"
[[ -f catalog.json ]] || { echo "Error: catalog.json not in '$SRC'." >&2; exit 1; }

rm -f "$OUT"                          # start clean; zip appends otherwise

shopt -s nullglob
dirs=()
for d in */; do
  [[ "$d" == "$EXCLUDE_DIR/" ]] && continue
  dirs+=("$d")
done
shopt -u nullglob

zip -rq "$OUT" catalog.json "${dirs[@]}"
echo "Created $OUT ($(du -h "$OUT" | cut -f1))"