#!/usr/bin/env bash
set -euo pipefail

echo "=== Portfolio Monitor — Local Build ==="

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm ci
fi

# Run tests
echo "Running tests..."
npm test

# Build dashboard
echo "Building dashboard..."
npm run build

echo ""
echo "=== Build complete ==="
echo "Open public/index.html in your browser to preview the dashboard."
echo ""

# Try to open in default browser (macOS)
if command -v open &> /dev/null; then
  read -p "Open dashboard in browser? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    open public/index.html
  fi
fi
