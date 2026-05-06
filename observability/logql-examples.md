# LogQL examples (Loki + Grafana Explore)

## Assumptions
- Label `service` contains Docker service name (`users`, `posts`, `sentiment`, `toxicity`, `zeroshot`, `rabbitmq`).
- JSON fields like `correlationId`, `postId`, `messageId` remain JSON payload fields (not labels).

## Queries

### 1) All logs from `posts`
```logql
{service="posts"}
```

### 2) All errors from all services
```logql
{service=~"users|posts|sentiment|toxicity|zeroshot|rabbitmq"} | json | level=~"error|ERROR"
```

### 3) Full flow by one `correlationId`
```logql
{service=~"users|posts|sentiment|toxicity|zeroshot"} | json | correlationId="<CORRELATION_ID>"
```

### 4) Logs for one `postId`
```logql
{service=~"posts|sentiment|toxicity|zeroshot"} | json | postId="<POST_ID>"
```

### 5) Logs from a specific classifier (`toxicity` example)
```logql
{service="toxicity"}
```

### 6) `message_nack` or `message_processing_failed` events
```logql
{service=~"posts|sentiment|toxicity|zeroshot"} |~ "message_nack|message_processing_failed"
```

## Demo scenario: trace one post end-to-end
1. Start stack:
   ```bash
   docker compose up -d --build
   ```
2. Create post via API (example):
   ```bash
   curl -X POST http://localhost:3002/posts \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer <JWT>' \
     -d '{"content":"This is my observable post"}'
   ```
3. Copy `correlationId` from API response/log (if response doesn't include it, read it from `posts` service log).
4. Open Grafana: `http://localhost:3000`
5. Go to **Explore** and choose **Loki** datasource.
6. Run:
   ```logql
   {service=~"users|posts|sentiment|toxicity|zeroshot"} | json | correlationId="<COPIED_CORRELATION_ID>"
   ```
7. You should see whole processing chain for that single post across services.
