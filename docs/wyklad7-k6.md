# Wykład 7: testy obciążeniowe k6 + Prometheus + Grafana

## 1) Uruchomienie infrastruktury

```bash
docker compose up -d --build --scale posts=3 --scale toxicity=3
```

Po starcie:
- Traefik: `http://localhost:8080`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000` (admin/admin)

## 2) Uruchomienie testu k6

Skrypt: `load-tests/create-posts.js`.

### Scenariusz A: posts=1, toxicity=1

```bash
docker compose up -d --build --scale posts=1 --scale toxicity=1

docker compose --profile loadtest run --rm \
  -e POSTS_COUNT=20 \
  -e VUS=1 \
  -e POLL_STATUS=true \
  k6 run -o experimental-prometheus-rw \
  --tag testid=posts1_toxicity1 \
  /scripts/create-posts.js
```

### Scenariusz B: posts=3, toxicity=1

```bash
docker compose up -d --build --scale posts=3 --scale toxicity=1

docker compose --profile loadtest run --rm \
  -e POSTS_COUNT=40 \
  -e VUS=5 \
  -e POLL_STATUS=true \
  k6 run -o experimental-prometheus-rw \
  --tag testid=posts3_toxicity1 \
  /scripts/create-posts.js
```

### Scenariusz C: posts=3, toxicity=3

```bash
docker compose up -d --build --scale posts=3 --scale toxicity=3

docker compose --profile loadtest run --rm \
  -e POSTS_COUNT=60 \
  -e VUS=10 \
  -e POLL_STATUS=true \
  k6 run -o experimental-prometheus-rw \
  --tag testid=posts3_toxicity3 \
  /scripts/create-posts.js
```

> `POLL_STATUS=false` wyłącza odpytywanie endpointu `/posts/:id/status`, dzięki czemu test działa także bez pomiaru czasu decyzji moderacyjnej.

## 3) Sprawdzenie metryk w Prometheusie

Przykładowe zapytania:

```promql
sum(demo_posts_created)
sum(demo_post_create_failed)
rate(http_reqs_total{endpoint="posts_create"}[1m])
histogram_quantile(0.95, sum by (le) (rate(k6_http_req_duration_bucket{endpoint="posts_create"}[5m])))
avg(demo_moderation_decision_duration)
```

## 4) Dashboard k6 dostępny automatycznie

Po uruchomieniu Grafany dashboard **PM2026 k6 Load Tests** jest automatycznie provisioningowany z pliku `observability/grafana/dashboards/k6-dashboard.json`.

## 5) (Opcjonalnie) import gotowego dashboardu k6 z Grafany.com (ID 19665)

1. Wejdź do Grafany: `http://localhost:3000`.
2. `Dashboards` → `New` → `Import`.
3. Wpisz ID: `19665` i kliknij `Load`.
4. Wybierz źródło danych Prometheus.
5. Zatwierdź import.

## 6) Prosty dashboard własny — proponowane PromQL

- Liczba utworzonych postów:
  ```promql
  sum(demo_posts_created{testid="$testid"})
  ```

- Liczba błędów tworzenia postów:
  ```promql
  sum(demo_post_create_failed{testid="$testid"})
  ```

- TPS endpointu tworzenia postów:
  ```promql
  sum(rate(http_reqs_total{endpoint="posts_create",testid="$testid"}[1m]))
  ```

- p95 czasu HTTP dla tworzenia postów:
  ```promql
  histogram_quantile(0.95, sum by (le) (rate(k6_http_req_duration_bucket{endpoint="posts_create",testid="$testid"}[5m])))
  ```

- Średni czas do decyzji moderacyjnej:
  ```promql
  avg(demo_moderation_decision_duration{testid="$testid"})
  ```
