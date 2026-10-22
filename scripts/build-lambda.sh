#!/usr/bin/env bash
# Builds the Lambda asset: runtime source + production deps only (no tests, docs, dev deps or local secrets).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf build/lambda && mkdir -p build/lambda/vendor/civicops
cp -r src data package.json package-lock.json build/lambda/
cp -r vendor/civicops/catalog build/lambda/vendor/civicops/
(cd build/lambda && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
echo "build/lambda: $(du -sh build/lambda | cut -f1)"
