#!/usr/bin/env bash
# sync-prod-data.sh
# Copies production app data to the dev app directory so you can
# debug with the same server connections, settings, and workspace state.
#
# Usage:
#   bash packages/desktop/scripts/sync-prod-data.sh
#
# Safe to run multiple times. Does NOT modify production data.

set -euo pipefail

PROD="$HOME/Library/Application Support/ai.opencode.desktop"
DEV="$HOME/Library/Application Support/ai.opencode.desktop.dev"

if [ ! -d "$PROD" ]; then
  echo "❌  Production data not found at: $PROD"
  exit 1
fi

mkdir -p "$DEV"

echo "📦  Syncing frontend state (.dat files) …"

# Core state files
for f in default.dat opencode.global.dat opencode.settings.dat; do
  src="$PROD/$f"
  if [ -f "$src" ]; then
    cp "$src" "$DEV/$f"
    echo "  ✓  $f"
  fi
done

# Workspace-specific state files
count=0
for f in "$PROD"/opencode.workspace.*.dat; do
  [ -f "$f" ] || continue
  cp "$f" "$DEV/$(basename "$f")"
  count=$((count + 1))
done
echo "  ✓  $count workspace .dat files"

# Backend session history (read-only symlink — shared with prod)
# NOTE: the opencode/ dir contains your actual AI session history.
# We symlink it so dev reads the same sessions without duplicating data.
PROD_OPENCODE="$PROD/opencode"
DEV_OPENCODE="$DEV/opencode"

if [ -d "$PROD_OPENCODE" ]; then
  if [ -L "$DEV_OPENCODE" ]; then
    echo "  ↩  opencode/ symlink already exists, skipping"
  elif [ -d "$DEV_OPENCODE" ]; then
    echo "  ⚠️  $DEV_OPENCODE is a real directory — NOT replacing with symlink"
    echo "      Delete it manually if you want to share prod session history."
  else
    ln -s "$PROD_OPENCODE" "$DEV_OPENCODE"
    echo "  ✓  opencode/ → symlinked to prod session history"
  fi
fi

echo ""
echo "✅  Done. Dev app now has the same data as production."
echo ""
echo "Next: start the dev build"
echo "  cd packages/desktop && bun tauri dev"
echo ""
echo "Once the app opens:"
echo "  Right-click anywhere → Inspect (DevTools is now enabled)"
echo "  Sources tab → ☑️  Pause on uncaught exceptions"
echo "  Run ~4 agents → crash will break at the exact source line"
