# docker compose up -d --build --scale posts=1 --scale toxicity=1

docker compose --profile loadtest run --rm `
   -e POSTS_COUNT=40 `
   -e VUS=1 `
   -e POLL_STATUS=true `
   -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write `
   -e K6_PROMETHEUS_RW_PUSH_INTERVAL=1s `
   k6 run -o experimental-prometheus-rw `
   --tag testid=posts1_toxicity2_a `
   /scripts/create-posts.js

# docker compose down