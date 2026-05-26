#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$HOME/git/personal/vault/.obsidian/plugins/kanban-bases-view"

echo "Building..."
npm run build

echo "Deploying to $PLUGIN_DIR..."
cp dist/main.js     "$PLUGIN_DIR/main.js"
cp dist/manifest.json "$PLUGIN_DIR/manifest.json"
cp dist/styles.css  "$PLUGIN_DIR/styles.css"

echo "Done."
