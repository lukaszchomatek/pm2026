body=$(jq -n '{
  username: "lukas2",
  password: "haslohaslo"
}')

curl -X POST "http://localhost:3001/register" \
  -H "Content-Type: application/json" \
  -d "$body"