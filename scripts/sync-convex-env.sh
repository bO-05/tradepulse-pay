#!/usr/bin/env bash
# Sets the Convex deployment environment from a local secrets file without
# printing any value. Values are piped to `convex env set` on stdin so they never
# appear in process arguments or shell history.
#
# Usage:
#   bash scripts/sync-convex-env.sh
#   SECRETS_FILE=/path/to/secrets.env bash scripts/sync-convex-env.sh
#   EXPECTED_DEPLOYMENT=<name> SITE_URL=https://... bash scripts/sync-convex-env.sh
#
# The secrets file must define CONVEX_DEPLOY_KEY for the target deployment.
# JWT_PRIVATE_KEY and JWKS are managed by the Convex Auth setup, not this script.
set -euo pipefail

SECRETS_FILE="${SECRETS_FILE:-/home/factory-user/hackathon-plan/secrets.env}"
EXPECTED_DEPLOYMENT="${EXPECTED_DEPLOYMENT:-exuberant-boar-323}"
SITE_URL_OVERRIDE="${SITE_URL:-}"

if [ ! -r "$SECRETS_FILE" ]; then
  echo "Secrets file not readable: $SECRETS_FILE" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

set +x
set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "CONVEX_DEPLOY_KEY is not set in $SECRETS_FILE" >&2
  exit 1
fi
case "$CONVEX_DEPLOY_KEY" in
  *brainy-skunk-440*)
    echo "Refusing: the deploy key targets brainy-skunk-440, which must never be modified." >&2
    exit 1
    ;;
  *":${EXPECTED_DEPLOYMENT}|"*) ;;
  *)
    echo "Refusing: CONVEX_DEPLOY_KEY does not target ${EXPECTED_DEPLOYMENT}." >&2
    exit 1
    ;;
esac
export CONVEX_DEPLOY_KEY

# Names copied from the secrets file as-is.
FROM_SECRETS=(
  ANTHROPIC_API_KEY
  PAYPAL_CLIENT_ID
  PAYPAL_CLIENT_SECRET
  PAYPAL_ENV
  PAYPAL_WEBHOOK_ID
  PAYPAL_SANDBOX_GC_BUYER_EMAIL
  PAYPAL_SANDBOX_SUB1_EMAIL
  PAYPAL_SANDBOX_SUB2_EMAIL
  PAYPAL_SANDBOX_SUB3_EMAIL
  PAYPAL_SANDBOX_OWNER_EMAIL
  KERNEL_API_KEY
  FIRECRAWL_API_KEY
  AGENTMAIL_API_KEY
  AUTH_AGENTID_ID
  AUTH_AGENTID_SECRET
)

# Non-secret literals, overridable from the secrets file or the caller's env.
: "${ANTHROPIC_MODEL:=claude-sonnet-5-5}"
SITE_URL="${SITE_URL_OVERRIDE:-${SITE_URL:-http://localhost:3150}}"
LITERALS=(ANTHROPIC_MODEL SITE_URL)

failures=0
missing=0

set_var() {
  local name="$1" value="$2" out
  if out=$(printf '%s' "$value" | npx convex env set "$name" 2>&1); then
    echo "set     $name"
  else
    # Show the CLI error with the value scrubbed, in case it was echoed back.
    echo "FAILED  $name" >&2
    printf '%s\n' "$out" | grep -vF -- "$value" | sed 's/^/        /' >&2 || true
    failures=$((failures + 1))
  fi
}

for name in "${FROM_SECRETS[@]}" "${LITERALS[@]}"; do
  value="${!name:-}"
  if [ -z "$value" ]; then
    echo "missing $name (not set in $SECRETS_FILE; skipped)" >&2
    missing=$((missing + 1))
    continue
  fi
  set_var "$name" "$value"
done

echo "done: $failures failed, $missing missing"
[ "$failures" -eq 0 ]
