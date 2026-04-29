# logowanie
login_response=$(curl -s -X POST "http://localhost:3001/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"lukas2","password":"haslohaslo"}')

token=$(echo "$login_response" | jq -r '.token')
echo "$token"

# utworzenie posta
body=$(jq -n '{
  text: "Docker is sooooooo good!"
}')

curl -X POST "http://localhost:3002/posts" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $token" \
  -d "$body"