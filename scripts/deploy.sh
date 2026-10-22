#!/usr/bin/env bash
# One-command deploy to the AWS Activate account (us-east-1). Idempotent; safe to re-run.
# Needs: AWS credentials in the environment or a named profile (AWS_PROFILE), Node 20+, Python 3.11+.
# Inputs (files, never argv):  .deploy/households.json  -> [{"id":"demo","email":"...","name":"...","passcode_file":"/path/0600"}]
#                              .deploy/alexa_redirects  -> one Alexa redirect URI per line (from `alexa-ai`), optional at first deploy
# Env:  BUDGET_EMAIL (required)  AGENT_IMAGE_URI (optional, enables AgentCore)  MODEL_ID (default us.amazon.nova-lite-v1:0)
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 JSII_SILENCE_WARNING_DEPRECATED_NODE_VERSION=1
: "${BUDGET_EMAIL:?set BUDGET_EMAIL}"
MODEL_ID="${MODEL_ID:-us.amazon.nova-lite-v1:0}"
PARAM=/fixwise/prod/secrets
mkdir -p .deploy && chmod 700 .deploy

step() { printf '\n== %s\n' "$*"; }
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip -q install -r infra/requirements.txt awscli >/dev/null
export PATH="$PWD/.venv/bin:$PATH"

step "1/7 identity"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "account $ACCOUNT, region $AWS_REGION"

step "2/7 Bedrock model access ($MODEL_ID)"
if aws bedrock-runtime converse --model-id "$MODEL_ID" --messages '[{"role":"user","content":[{"text":"ping"}]}]' --inference-config maxTokens=5 >/dev/null 2>&1; then echo "model OK"; else echo "WARN: model not callable yet; the advisor falls back to the deterministic note until access is granted"; fi

step "3/7 OAuth client for Alexa+ (secret kept in .deploy/client_secret, only its hash goes to SSM)"
[ -s .deploy/client_secret ] || node scripts/client-secret.mjs .deploy/client_secret >/dev/null
HASH=$(node -e "import('./src/util.js').then(async u=>console.log(await u.sha256(require('fs').readFileSync('.deploy/client_secret','utf8').trim())))")
REDIRECTS=$(node -e "const fs=require('fs');const l=fs.existsSync('.deploy/alexa_redirects')?fs.readFileSync('.deploy/alexa_redirects','utf8').split(/\s+/).filter(Boolean):[];console.log(JSON.stringify(l.length?l:['https://layla.amazon.com/api/skill/link/PENDING']))")

step "4/7 secrets parameter $PARAM (SecureString, hashes only)"
umask 077
[ -s .deploy/session_secret ] || node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > .deploy/session_secret
[ -s .deploy/origin_secret ] || node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > .deploy/origin_secret
[ -s .deploy/households.json ] || { echo "missing .deploy/households.json (see header)"; exit 1; }
SECRETS=$(HASH="$HASH" REDIRECTS="$REDIRECTS" node --input-type=module -e "
import { readFileSync } from 'node:fs'; import { pbkdf2, b64url } from './src/util.js';
const hh = JSON.parse(readFileSync('.deploy/households.json','utf8')); const out = [];
for (const h of hh) { const pass = readFileSync(h.passcode_file,'utf8').trim(); const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  out.push({ id: h.id, email: h.email.toLowerCase(), name: h.name || h.email, passcode_hash: 'pbkdf2\$310000\$'+salt+'\$'+await pbkdf2(pass, salt, 310000) }); }
console.log(JSON.stringify({ FIXWISE_CLIENTS: JSON.stringify([{ client_id: 'fixwise-alexa', client_name: 'Alexa', redirect_uris: JSON.parse(process.env.REDIRECTS), token_endpoint_auth_method: 'client_secret_basic', secret_hash: process.env.HASH }, { client_id: 'fixwise-judge', client_name: 'Fixwise judge client / MCP Inspector', redirect_uris: ['http://127.0.0.1:8976/callback', 'http://localhost:8976/callback', 'http://localhost:6274/oauth/callback', 'http://localhost:6274/oauth/callback/debug'], token_endpoint_auth_method: 'none' }]), HOUSEHOLDS: JSON.stringify(out), SESSION_SECRET: readFileSync('.deploy/session_secret','utf8').trim() }));")
printf '%s' "$SECRETS" > .deploy/secrets.json && chmod 600 .deploy/secrets.json
aws ssm put-parameter --name "$PARAM" --type SecureString --overwrite --value "file://.deploy/secrets.json" >/dev/null && rm -f .deploy/secrets.json
echo "parameter written"

step "5/7 build Lambda asset"
./scripts/build-lambda.sh

step "6/7 CDK bootstrap + deploy"
cd infra
npx -y aws-cdk@2 bootstrap "aws://$ACCOUNT/$AWS_REGION" --require-approval never >/dev/null
CTX=(-c "budgetEmail=$BUDGET_EMAIL" -c "modelId=$MODEL_ID" -c "secretsParam=$PARAM")
[ -n "${AGENT_IMAGE_URI:-}" ] && CTX+=(-c "agentImageUri=$AGENT_IMAGE_URI")
PUBLIC_ORIGIN="${PUBLIC_ORIGIN-https://alexa.culltron.app}"  # set PUBLIC_ORIGIN= (empty) to advertise the raw Function URL
[ -n "$PUBLIC_ORIGIN" ] && CTX+=(-c "publicOrigin=$PUBLIC_ORIGIN")
CTX+=(-c "originSecretFile=$(cd .. && pwd)/.deploy/origin_secret")  # the Worker must send this as x-fixwise-origin
npx -y aws-cdk@2 deploy Fixwise --require-approval never "${CTX[@]}" --outputs-file ../.deploy/outputs.json
cd ..
MCP_URL=$(node -e "console.log(require('./.deploy/outputs.json').Fixwise.McpUrl)")
echo "MCP_URL=$MCP_URL"

step "7/7 smoke test through $PUBLIC_ORIGIN (origin lock, both 401 mounts, latency)"
node --input-type=module -e "
const [raw, pub] = process.argv.slice(1); const ping = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}' };
const direct = await fetch(raw, ping); console.log('direct Function URL (expect 403):', direct.status);
if (!pub) process.exit(0);
const t = []; let s;
for (let i = 0; i < 12; i++) { const t0 = performance.now(); s = await fetch(pub + '/mcp', ping); t.push(performance.now() - t0); }
const a = await fetch(pub + '/alexa/mcp', ping); const prm = await (await fetch(pub + '/.well-known/oauth-protected-resource')).json(); t.sort((x, y) => x - y);
console.log('/mcp', s.status, 'www-authenticate:', s.headers.get('www-authenticate') ? 'present' : 'MISSING', '| /alexa/mcp', a.status, 'www-authenticate:', a.headers.get('www-authenticate') ? 'PRESENT' : 'absent', '| prm.resource', prm.resource, '| p50/p90 ms', t[6].toFixed(0), t[10].toFixed(0));
" "$MCP_URL" "$PUBLIC_ORIGIN"
cat <<MSG

Deployed. Next (owner): alexa-ai new mcp --name "Fixwise" --locale en-US --mcp-server-url "${PUBLIC_ORIGIN:-${MCP_URL%/mcp}}/alexa/mcp"
  Account linking: client id fixwise-alexa, secret in .deploy/client_secret (paste when the CLI asks),
  auth URL ${PUBLIC_ORIGIN}/authorize, token URL ${PUBLIC_ORIGIN}/token, scopes "fixwise.read fixwise.act".
  Put the redirect URIs the CLI shows into .deploy/alexa_redirects and re-run this script, then: alexa-ai deploy
Console (simulated Alexa+): ${PUBLIC_ORIGIN}/console
  The Function URL is origin-locked: point the Cloudflare Worker at it with ORIGIN_SECRET = .deploy/origin_secret.
MSG
