#!/usr/bin/env bash
# Re-pull the Impeccable detector engine into vendor/impeccable/engine.
# Usage: vendor-sync.sh <path-to-impeccable-checkout>
set -eu
SRC="${1:?usage: vendor-sync.sh <impeccable-checkout>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -d "$SRC/cli/engine" ] || { echo "not an impeccable checkout: $SRC"; exit 1; }
rm -rf "$HERE/engine"; mkdir -p "$HERE/engine"
cp -R "$SRC/cli/engine/." "$HERE/engine/"
cp "$SRC/LICENSE" "$HERE/LICENSE"
# Drop the CLI entry layer that escapes the engine tree (we call the engine directly).
rm -rf "$HERE/engine/cli" "$HERE/engine/node" "$HERE/engine/detect-antipatterns.mjs"
COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "synced engine at $COMMIT — update NOTICE 'Pinned at' line by hand"
