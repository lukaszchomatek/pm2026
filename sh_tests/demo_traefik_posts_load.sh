#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
USERS_URL="${USERS_URL:-http://localhost:3001}"
USERNAME="${USERNAME:-demo_user}"
PASSWORD="${PASSWORD:-demo_pass}"
POSTS_COUNT="${POSTS_COUNT:-30}"

printf "[demo] register user %s\n" "$USERNAME"
curl -sS -X POST "$USERS_URL/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\",\"displayName\":\"Demo User\"}" >/dev/null || true

printf "[demo] login user %s\n" "$USERNAME"
TOKEN=$(curl -sS -X POST "$USERS_URL/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [[ -z "$TOKEN" ]]; then
  echo "[demo] login failed - missing token" >&2
  exit 1
fi

printf "[demo] creating %s posts through Traefik (%s/posts)\n" "$POSTS_COUNT" "$BASE_URL"
for i in $(seq 1 "$POSTS_COUNT"); do
  curl -sS -X POST "$BASE_URL/posts" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"demo post #$i $(date -u +%s%N)\"}" >/dev/null
  if (( i % 10 == 0 )); then
    printf "  posted: %s\n" "$i"
  fi
done

echo "[demo] done"
echo "[demo] sample instance hit:"
curl -sS "$BASE_URL/posts/instance"; echo
