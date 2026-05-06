# Observability (logs + metrics) - demo

## Uruchomienie
1. `docker compose up --build`
2. Grafana: http://localhost:3000 (admin/admin)
3. Prometheus UI: http://localhost:9090
4. RabbitMQ UI: http://localhost:15672

## Co jest skonfigurowane
- Loki + Alloy: centralne logi JSON.
- Prometheus: scrape `/metrics` z `posts`, `users`, `sentiment`, `toxicity`, `zeroshot` oraz `rabbitmq`.
- Grafana provisioning:
  - datasource Loki,
  - datasource Prometheus,
  - dashboard **PM2026 Observability Basics**.

## Logi vs metryki (na zajęcia)
- **Logi**: analiza pojedynczego przypadku (np. jeden `requestId` lub `correlationId`).
- **Metryki**: trend i stan systemu (RPS, błędy, kolejki, czasy).

## Dashboard: PM2026 Observability Basics
Panele:
- HTTP requests (posts)
- HTTP errors (posts)
- Posts per final status
- Classification results per classifier
- Classifier errors
- Fallbacks per classifier
- Classification duration p95 (posts)
- RabbitMQ queue depth + ready + unacked

## Szybkie demo
1. Zarejestruj usera i zaloguj się (skrypty w `sh_tests/` albo `ps_tests/`).
2. Utwórz kilka postów (`POST /posts`) i obserwuj:
   - wzrost `http_requests_total`,
   - wzrost `posts_created_total`,
   - zmiany `posts_status_total`.
3. Wymuś błędy klasyfikatora np. `FAIL_MODE=always` dla jednego serwisu i restart kontenera.
4. Obserwuj:
   - `classifier_errors_total`,
   - `classification_results_total{status="failed"}`,
   - `classification_fallbacks_total`,
   - wzrost wiadomości `ready/unacked` w RabbitMQ panelu.
5. Potem w Grafanie przejdź do Loki i przeanalizuj konkretny przypadek po `correlationId`.

## Ograniczenia
- Bez OpenTelemetry/trace collectorów/Jaeger/Tempo.
- Bez alertingu (celowo: etap podstawowy).
