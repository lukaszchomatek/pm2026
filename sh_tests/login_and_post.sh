#!/usr/bin/env sh

TOKEN=$(
  curl -s -X POST "http://localhost:3001/login" \
    -H "Content-Type: application/json" \
    -d '{
      "username": "user1",
      "password": "tajnehaslo"
    }' | jq -r '.token'
)

curl -X POST "http://localhost:3002/posts" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "text": "Microservices are awesome."
  }'