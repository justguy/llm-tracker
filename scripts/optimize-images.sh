#!/usr/bin/env bash
# Optimize every PNG under img/ in place. Run after adding or updating screenshots.
# Requires pngquant (brew install pngquant). oxipng is used if available.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v pngquant >/dev/null 2>&1; then
  echo "pngquant not found. Install with: brew install pngquant" >&2
  exit 1
fi

has_oxipng=false
if command -v oxipng >/dev/null 2>&1; then
  has_oxipng=true
fi

total_before=0
total_after=0
for f in img/*.png; do
  [ -f "$f" ] || continue
  before=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  pngquant --force --output "$f" --quality=70-90 --speed=1 --strip "$f"
  if $has_oxipng; then
    oxipng -o max --strip all "$f" >/dev/null 2>&1 || true
  fi
  after=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  saved=$(( before - after ))
  pct=$(( (saved * 100) / before ))
  printf "  %-30s %8d -> %8d  (%d%% smaller)\n" "$f" "$before" "$after" "$pct"
  total_before=$(( total_before + before ))
  total_after=$(( total_after + after ))
done

saved=$(( total_before - total_after ))
pct=$(( (saved * 100) / total_before ))
printf "\n  TOTAL                          %8d -> %8d  (%d%% smaller)\n" "$total_before" "$total_after" "$pct"
