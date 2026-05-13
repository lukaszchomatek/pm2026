#!/usr/bin/env bash
set -euo pipefail

docker compose up -d --build --scale posts=1 --scale toxicity=1

docker compose --profile loadtest run --rm \
  -e POSTS_COUNT=20 \
  -e VUS=1 \
  -e POLL_STATUS=true \
  k6 run -o experimental-prometheus-rw \
  --tag testid=posts1_toxicity1 \
  /scripts/create-posts.js

docker compose down