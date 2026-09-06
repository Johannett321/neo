#!/usr/bin/env bash
#
# Two devices, one account, a real sync server.
#
# Needs a server running and a Postgres behind it — see the server repository's
# README. It seeds a device token directly, because a passkey needs an authenticator
# and a headless test does not have one; everything after that is the real path.
#
#   NEO_SYNC_URL=http://localhost:18080 test/sync.sh

set -uo pipefail

URL="${NEO_SYNC_URL:-http://localhost:18080}"
PG="${PG:-neo-sync-pg}"
PASSPHRASE="a passphrase worth typing"
STAMP=$(date +%s)
HANDLE="sync-test-$STAMP@example.com"
TOKEN="sync-test-token-$STAMP"
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)

psqlq() { docker exec "$PG" psql -U postgres -d neosync -Atc "$1"; }

psqlq "INSERT INTO account (handle, quota_bytes) VALUES ('$HANDLE', 1000000)" >/dev/null
ACCOUNT=$(psqlq "SELECT id FROM account WHERE handle='$HANDLE'")
psqlq "INSERT INTO device (account_id,name,platform,token_hash)
       VALUES ('$ACCOUNT','sync-test','test',decode('$HASH','hex'))" >/dev/null

npx --no-install esbuild test/sync.ts --bundle --platform=node --format=esm --target=node22 \
  --outfile=out/sync.mjs --external:@electric-sql/pglite --external:openai \
  --alias:electron=./test/electron-stub.mjs --alias:@shared=./src/shared >/dev/null || exit 1

ONE=$(mktemp -d)/one
TWO=$(mktemp -d)/two
export NEO_SYNC_URL="$URL" NEO_SYNC_TOKEN="$TOKEN" NEO_SYNC_ACCOUNT="$ACCOUNT" \
       NEO_SYNC_PASSPHRASE="$PASSPHRASE"

echo "--- device one: writes and pushes ---"
PUSHED=$(PM_TEST_DIR="$ONE" node out/sync.mjs push)
echo "$PUSHED" | grep -v '^WORKSPACE=\|^PROJECT=\|^ICON='
export NEO_SYNC_WORKSPACE=$(echo "$PUSHED" | sed -n 's/^WORKSPACE=//p')
export NEO_SYNC_PROJECT=$(echo "$PUSHED" | sed -n 's/^PROJECT=//p')
export NEO_SYNC_ICON=$(echo "$PUSHED" | sed -n 's/^ICON=//p')

echo
echo "--- device two: has never seen any of it ---"
PM_TEST_DIR="$TWO" node out/sync.mjs pull
RESULT=$?

psqlq "DELETE FROM account WHERE handle='$HANDLE'" >/dev/null
rm -rf "$ONE" "$TWO"
exit "$RESULT"
