#!/usr/bin/env bash
# Code-only deploy of the MCP Lambda with a rollback point. Infra and secrets are untouched (use deploy.sh for those).
#   scripts/code-deploy.sh "<description>"   -> snapshots nothing new; publishes the new code as a version, alias "live"
#   scripts/code-deploy.sh --rollback <ver>  -> puts that published version's code back on $LATEST (the Function URL)
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION=us-east-1
F=$(node -e "console.log(require('./.deploy/outputs.json').Fixwise.FunctionName||'')" 2>/dev/null || true); F=${F:-Fixwise-Mcp32112EE5-lyVh0UjyJNdS}
if [ "${1:-}" = "--rollback" ]; then
  URL=$(aws lambda get-function --function-name "$F" --qualifier "$2" --query Code.Location --output text)
  curl -fsS "$URL" -o build/rollback.zip && aws lambda update-function-code --function-name "$F" --zip-file fileb://build/rollback.zip >/dev/null
  aws lambda wait function-updated --function-name "$F"; echo "rolled back to version $2"; exit 0
fi
PREV=$(aws lambda get-alias --function-name "$F" --name live --query FunctionVersion --output text)
npm test >/dev/null || { echo "tests failed: not deploying"; exit 1; }
gitleaks git --no-banner . >/dev/null 2>&1 || { echo "gitleaks found something: not deploying"; exit 1; }
./scripts/build-lambda.sh
rm -f build/fx.zip; (cd build/lambda && python3 -c "import shutil;shutil.make_archive('../fx','zip','.')")
aws lambda update-function-code --function-name "$F" --zip-file fileb://build/fx.zip >/dev/null
aws lambda wait function-updated --function-name "$F"
N=$(aws lambda publish-version --function-name "$F" --description "${1:-code deploy} $(git rev-parse --short HEAD)" --query Version --output text)
aws lambda update-alias --function-name "$F" --name live --function-version "$N" >/dev/null
echo "deployed version $N (rollback: scripts/code-deploy.sh --rollback <previous version>)"
if [ "${SKIP_SMOKE:-}" != 1 ]; then
  if ! timeout 600 python3 scripts/e2e-smoke.py "${SMOKE_URL:-https://alexa.culltron.app}" ${SMOKE_SHOTS:-}; then
    echo "E2E smoke failed on version $N: rolling back to $PREV"
    "$0" --rollback "$PREV"; aws lambda update-alias --function-name "$F" --name live --function-version "$PREV" >/dev/null; exit 1
  fi
fi
