#!/bin/sh
# Deploy foliozzz to the host volume and inject the OpenRouter API key.
# Usage: ./deploy.sh [OPENROUTER_API_KEY]
#
# The API key can be passed as an argument or via OPENROUTER_API_KEY env var.

set -e

DEPLOY_DIR="/opt/nomad/volumes/foliozzz_data"
API_KEY="${1:-$OPENROUTER_API_KEY}"

echo "Building..."
npm run build

echo "Deploying to $DEPLOY_DIR..."
sudo cp app.js index.html styles.css duckdb-module.js "$DEPLOY_DIR/"

if [ -n "$API_KEY" ]; then
    echo "Injecting API key..."
    sudo sed -i "s|__OPENROUTER_API_KEY__|${API_KEY}|g" "$DEPLOY_DIR/app.js"
fi

echo "Done. Files deployed to $DEPLOY_DIR"
