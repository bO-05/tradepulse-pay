#!/usr/bin/env bash
# Generates the Convex Auth signing key pair (JWT_PRIVATE_KEY + JWKS) on the
# target deployment, without printing either value. Skips deployments that
# already have JWT_PRIVATE_KEY unless ROTATE=1 (rotating signs every user out).
#
# Usage:
#   bash scripts/setup-convex-auth-keys.sh
#   SECRETS_FILE=/path/to/secrets.env EXPECTED_DEPLOYMENT=<name> bash scripts/setup-convex-auth-keys.sh
#   ROTATE=1 bash scripts/setup-convex-auth-keys.sh
#
# SITE_URL is set by scripts/sync-convex-env.sh.
set -euo pipefail

SECRETS_FILE="${SECRETS_FILE:-/home/factory-user/hackathon-plan/secrets.env}"
EXPECTED_DEPLOYMENT="${EXPECTED_DEPLOYMENT:-exuberant-boar-323}"
ROTATE="${ROTATE:-0}"

cd "$(dirname "$0")/.."

set +x
set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

case "${CONVEX_DEPLOY_KEY:-}" in
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

if npx convex env list | cut -d= -f1 | grep -qx JWT_PRIVATE_KEY && [ "$ROTATE" != "1" ]; then
  echo "JWT_PRIVATE_KEY already set on ${EXPECTED_DEPLOYMENT}; skipping (ROTATE=1 to replace)."
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"

node --input-type=module - "$tmp" <<'NODE'
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { writeFileSync } from "node:fs";
const dir = process.argv[2];
const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
// Convex Auth expects the PEM on one line with spaces in place of newlines.
writeFileSync(`${dir}/jwt_private_key`, privateKey.trimEnd().replace(/\n/g, " "), { mode: 0o600 });
writeFileSync(`${dir}/jwks`, JSON.stringify({ keys: [{ use: "sig", ...publicKey }] }), { mode: 0o600 });
NODE

npx convex env set JWT_PRIVATE_KEY < "$tmp/jwt_private_key" >/dev/null && echo "set     JWT_PRIVATE_KEY"
npx convex env set JWKS < "$tmp/jwks" >/dev/null && echo "set     JWKS"
