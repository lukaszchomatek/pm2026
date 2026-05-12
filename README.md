# Demo microservices with AI sentiment analysis

Prosta aplikacja demonstracyjna uruchamiana przez Docker Compose. Składa się z trzech usług biznesowych i dwóch baz danych:

- `users` — rejestracja i logowanie użytkownika
- `posts` — publikowanie postów przez zalogowanego użytkownika
- `hf-model-service` — analiza postów z użyciem modeli z Hugging Face (kilka wariantów)
- `redis` — magazyn użytkowników
- `mongo` — magazyn postów

## Architektura

- Użytkownik rejestruje się i loguje przez usługę `users`.
- Usługa `users` zapisuje dane użytkownika w Redisie.
- Po poprawnym logowaniu `users` zwraca token JWT.
- Zalogowany użytkownik wysyła żądanie do `posts`, aby opublikować post.
- Usługa `posts` weryfikuje token JWT.
- Usługa `posts` pobiera profil autora z `users` i zapisuje jego snapshot razem z postem.
- Usługa `posts` zapisuje post jako `PENDING_CLASSIFICATION` i publikuje `classification.requested` do RabbitMQ.
- Klasyfikatory (`sentiment`, `toxicity`, `zeroshot`) konsumują event i publikują `classification.result.<classifier>` albo `classification.failed.<classifier>`.
- Usługa `posts` konsumuje wyniki przez `posts.classification.results`, aktualizuje dokument w MongoDB i ustala status końcowy (`PUBLISHED`, `REVIEW_REQUIRED`, `CLASSIFICATION_FAILED`).
- `posts` pozostaje właścicielem danych: klasyfikatory nie zapisują bezpośrednio do MongoDB.

## Stos technologiczny

- `users`: Node.js, Express, Redis, JWT, bcrypt
- `posts`: Node.js, Express, MongoDB, JWT
- `hf-models-service`: Python, FastAPI, Hugging Face Transformers, PyTorch
- Orkiestracja lokalna: Docker Compose

## Struktura katalogów

```text
demo-microservices/
├─ compose.yml
├─ users/
│  ├─ Dockerfile
│  ├─ package.json
│  └─ src/
│     └─ index.js
├─ posts/
│  ├─ Dockerfile
│  ├─ package.json
│  └─ src/
│     └─ index.js
└─ hf-model-service/
   ├─ Dockerfile
   ├─ requirements.txt
   └─ app/
      ├─ core
      ├─ services
      ├─ __init__.py
      └─ bootstrap.py
```

## Wymagania

- Docker
- Docker Compose
- Dla usługi `hf-model-service`:
  - najlepiej Docker z obsługą GPU
  - poprawnie skonfigurowane sterowniki NVIDIA i środowisko kontenerowe GPU

Aplikacja może działać także bez GPU, ale wtedy trzeba odpowiednio zmienić konfigurację usługi `hf-model-service`.

## Uruchomienie

W katalogu głównym projektu:

```bash
docker compose up --build
```

Traefik (reverse proxy/load balancer dla `posts`) jest dostępny na:
- `http://localhost:8080` — ruch HTTP do endpointów `posts`
- `http://localhost:8081/dashboard/` — dashboard Traefika

### Skalowanie `posts` przez Traefik

Jedna instancja `posts`:

```bash
docker compose up -d --build
```

Trzy instancje `posts`:

```bash
docker compose up -d --build --scale posts=3
```

Test rozkładu ruchu (uruchom kilka razy i porównaj `instanceId`/`hostname`):

```bash
curl http://localhost:8080/posts/instance
```

### Skalowanie konsumenta `toxicity` (RabbitMQ)

Scenariusz A: 1 replika `toxicity`, opóźnienie 3000 ms na wiadomość:

```bash
docker compose up -d --build --scale toxicity=1
```

Praktycznie (zalecane w Compose): ustaw w `compose.yml` dla usługi `toxicity`:
- `TOXICITY_DELAY_MS=3000`
- `PREFETCH_COUNT=1`

Scenariusz B: 3 repliki `toxicity`, opóźnienie 3000 ms na wiadomość:

```bash
docker compose up -d --build --scale toxicity=3
```

Obserwacja długości kolejki w RabbitMQ Management:
- Otwórz `http://localhost:15672`
- Przejdź do **Queues**
- Obserwuj kolejkę `toxicity.requests` (Ready / Unacked) podczas wysyłania postów.

Po uruchomieniu dostępne będą usługi:

- `users` — `http://localhost:3001`
- `posts` (przez Traefik) — `http://localhost:8080`
- `hf-model-service (sentiment)` — `http://localhost:8000`
- `hf-model-service (toxicity)` — `http://localhost:8001`
- `hf-model-service (zero-shot)` — `http://localhost:8002`


## Endpointy

### `users`

#### Health check

```http
GET /health
```

#### Rejestracja

```http
POST /register
Content-Type: application/json
```

Przykładowe body:

```json
{
  "username": "user1",
  "password": "tajnehaslo",
  "displayName": "User One",
  "role": "student",
  "group": "default"
}
```

Pola `displayName`, `role`, `group` są opcjonalne.

#### Profil użytkownika (do integracji między usługami)

```http
GET /users/:username/profile
```

#### Logowanie

```http
POST /login
Content-Type: application/json
```

Przykładowe body:

```json
{
  "username": "user1",
  "password": "tajnehaslo"
}
```

Przykładowa odpowiedź:

```json
{
  "token": "..."
}
```

---

### `posts`

#### Health check

```http
GET /health
```

#### Dodanie posta

```http
POST /posts
Authorization: Bearer <token>
Content-Type: application/json
```

Przykładowe body:

```json
{
  "text": "Microservices are awesome."
}
```

#### Lista wszystkich postów

```http
GET /posts
```

Domyślnie endpoint zwraca tylko posty o statusie `PUBLISHED`.

#### Lista własnych postów

```http
GET /posts/me
Authorization: Bearer <token>
```

#### Backfill klasyfikacji (demo)

```http
POST /admin/classification/backfill
```

Uruchamia ponowną publikację `classification.requested` dla postów wymagających dogrania klasyfikacji.

---

### `sentiment`

#### Health check

```http
GET /health
```

#### Predykcja sentymentu

```http
POST /predict
Content-Type: application/json
```

Przykładowe body:

```json
{
  "text": "Microservices are awesome."
}
```

## Przykładowy scenariusz testowy

### 1. Rejestracja użytkownika

```bash
curl -X POST "http://localhost:3001/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "user1",
    "password": "tajnehaslo"
  }'
```

### 2. Logowanie

```bash
curl -X POST "http://localhost:3001/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "user1",
    "password": "tajnehaslo"
  }'
```

### 3. Dodanie posta

```bash
curl -X POST "http://localhost:8080/posts" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_WKLEJ_TOKEN" \
  -d '{
    "text": "Microservices are awesome."
  }'
```

### 4. Pobranie listy postów

```bash
curl -X GET "http://localhost:8080/posts"
```

### 5. Backfill klasyfikacji (opcjonalnie)

```bash
curl -X POST "http://localhost:3002/admin/classification/backfill"
```

Przykładowa odpowiedź:

```json
{
  "matched": 10,
  "published": 10
}
```

## RabbitMQ: DLQ (demo)

Topologia klasyfikacji tworzy kolejki główne i `.dlq`:

- `sentiment.requests` + `sentiment.requests.dlq`
- `toxicity.requests` + `toxicity.requests.dlq`
- `zeroshot.requests` + `zeroshot.requests.dlq`
- `posts.classification.results` + `posts.classification.results.dlq`

Wszystkie DLQ są podpięte do exchange `classification` przez routing key `classification.dlq.*`.

### Jak wymusić błąd i zobaczyć wiadomość w DLQ wyników

1. Opublikuj ręcznie uszkodzony JSON do kolejki wyników (albo event bez `postId` / `classificationRunId`).
2. Consumer `posts` odrzuci (`nack requeue=false`) wiadomość.
3. RabbitMQ przeniesie wiadomość do `posts.classification.results.dlq`.

## Przykładowe skrypty

Do testowania można użyć:
- skryptów `.ps1` w PowerShell
- skryptów `.sh` w systemach Linux/macOS

## Konfiguracja

Najważniejsze zmienne środowiskowe:

### `users`

- `PORT`
- `REDIS_URL`
- `JWT_SECRET`

### `posts`

- `PORT`
- `MONGO_URL`
- `JWT_SECRET`
- `USERS_URL`
- `SENTIMENT_URL`

### `hf-model-service`

- `MODEL_ID`
- `USE_GPU`
- `LOG_LEVEL`

## Bazy danych

### Redis

Usługa `users` zapisuje użytkowników pod kluczami w rodzaju:

```text
user:<username>
```

Wartość zawiera nazwę użytkownika i hash hasła.

### MongoDB

Usługa `posts` zapisuje dokumenty zawierające m.in.:

- autora
- treść posta
- wynik sentymentu
- datę utworzenia

## Uproszczenia przyjęte celowo

Projekt ma charakter demonstracyjny. Celowo pominięto m.in.:

- refresh tokeny
- role i uprawnienia
- reset hasła
- walidację siły hasła
- dedykowaną usługę auth
- retry i circuit breaker przy wywołaniu `hf-model-service`
- centralne logowanie
- metryki i tracing
- testy automatyczne
- kod w przypadku `hf-model-service` - są trzy pliki po to, żeby pokazać, że usługi mogą mieć różne API
- brak trwałego wolumenu dla Redisa

## Możliwe rozszerzenia

- dodanie frontendu WWW
- przekazywanie correlation ID między usługami
- centralne logowanie, np. Loki + Grafana
- metryki, np. Prometheus
- tracing rozproszony
- asynchroniczna komunikacja przez broker
- drugi model AI, np. zero-shot-classification
- współdzielony runtime dla wielu modeli
- cache modeli w wolumenie
- osobny API gateway

## Uwagi dotyczące modelu

W przykładzie użyto:

```text
cardiffnlp/twitter-roberta-base-sentiment-latest
```

Model ten dobrze nadaje się do prostego demo sentymentu dla tekstów angielskich. Przy pracy z innymi językami można zmienić `MODEL_ID` w konfiguracji kontenera `sentiment`.

## Zatrzymywanie środowiska

```bash
docker compose down
```

Aby usunąć także wolumen MongoDB:

```bash
docker compose down -v
```


## Wykład 7: skalowanie API i konsumentów kolejek

### Cel wykładu 7
Pokazać różnicę między skalowaniem warstwy API (`posts`) oraz skalowaniem wolniejszego etapu asynchronicznego (`toxicity`), który wpływa na czas decyzji publikacji/moderacji posta.

### Architektura demonstracyjna
`client -> Traefik -> posts replicas -> RabbitMQ -> toxicity replicas -> RabbitMQ -> posts`

### Komendy uruchomienia
Bez skalowania (po 1 replice):

```bash
docker compose up -d --build
```

Skalowanie API `posts` do 3 replik:

```bash
docker compose up -d --scale posts=3
```

Skalowanie konsumenta `toxicity` do 3 replik:

```bash
docker compose up -d --scale toxicity=3
```

Powrót do pojedynczych replik `posts` i `toxicity`:

```bash
docker compose up -d --scale posts=1 --scale toxicity=1
```

### Test rozkładu ruchu po `posts`
Wykonaj kilka razy:

```bash
curl http://localhost:8080/posts/instance
```

Przy `posts=3` odpowiedzi powinny rotować po różnych `instanceId`/`hostname`.

### Test wpływu `toxicity=1` vs `toxicity=3` na czas decyzji
1. Ustaw dla `toxicity` opóźnienie: `TOXICITY_DELAY_MS=3000` (w `compose.yml`).
2. Uruchom scenariusz A (`toxicity=1`) i wyślij serię postów:
   - Bash: `./sh_tests/demo_traefik_posts_load.sh`
   - PowerShell: `./ps_tests/demo_traefik_posts_load.ps1`
3. Obserwuj długość kolejki `toxicity.requests` w RabbitMQ (`http://localhost:15672`).
4. Powtórz dla scenariusza B (`toxicity=3`) i porównaj szybkość opróżniania kolejki oraz czas pojawiania się statusów końcowych.

### Competing consumers — co jest poprawne, a co błędne
- **Poprawne skalowanie:** wiele replik tego samego konsumenta (`toxicity`) na **tej samej kolejce** `toxicity.requests`.
- **Błędne podejście:** mieszanie różnych klasyfikatorów (`sentiment`, `toxicity`, `zeroshot`) na jednej wspólnej kolejce.
- W tym projekcie każdy klasyfikator ma osobną kolejkę requestów, więc klasyfikatory się nie „podkradają” nawzajem.

### Materiały pomocnicze (demo)
- Bash: `sh_tests/demo_traefik_posts_load.sh`
- PowerShell: `ps_tests/demo_traefik_posts_load.ps1`
- k6 (opcjonalnie): `sh_tests/k6_posts_via_traefik.js`

Przykład uruchomienia k6:

```bash
# Najpierw pobierz token np. przez login w users
k6 run -e BASE_URL=http://localhost:8080 -e TOKEN=<JWT_TOKEN> -e VUS=20 -e DURATION=60s sh_tests/k6_posts_via_traefik.js
```

### Troubleshooting
- **Konflikt portów:** sprawdź czy porty 8080, 8081, 15672, 3000, 9090 nie są zajęte przez inne procesy.
- **`container_name` i skalowanie:** usługi skalowane (`posts`, `toxicity`) nie powinny mieć wymuszonego `container_name`, bo blokuje to repliki.
- **`unacked messages`:** przy wolnym konsumencie liczba `Unacked` może rosnąć; sprawdź `PREFETCH_COUNT` i opóźnienie `TOXICITY_DELAY_MS`.
- **Kolejka się nie opróżnia:** zweryfikuj, czy kontenery `toxicity` są healthy i czy nie ma błędów połączenia do RabbitMQ.
- **Traefik nie widzi usługi:** sprawdź etykiety `traefik.*` na `posts` i czy Traefik ma dostęp do socketa Docker.
- **Endpoint działa tylko wewnątrz Compose:** upewnij się, że ruch z hosta idzie przez `http://localhost:8080` (Traefik), a nie bezpośrednio na `posts`.
