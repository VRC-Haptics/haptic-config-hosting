#!/usr/bin/env bash

# Creates an archive snapshot of the publicly published maps.
# Ignores all site files (in the root directory other than catalog.json)

set -euo pipefail

SRC="${1:-/var/www/haptic}"          # source dir (default: web root)
OUT="${2:-$HOME/archive.zip}"        # output zip (default: ~/archive.zip)
OUT="$(realpath -m "$OUT")"

[[ -d "$SRC" ]]       || { echo "Error: source '$SRC' not found." >&2; exit 1; }
cd "$SRC"
[[ -f catalog.json ]] || { echo "Error: catalog.json not in '$SRC'." >&2; exit 1; }

rm -f "$OUT"                          # start clean; zip appends otherwise

shopt -s nullglob
dirs=( */ )                           # every top-level subdirectory
shopt -u nullglob

zip -rq "$OUT" catalog.json "${dirs[@]}"
echo "Created $OUT ($(du -h "$OUT" | cut -f1))"