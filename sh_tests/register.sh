#!/usr/bin/env sh

curl -X POST "http://localhost:3001/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "user1",
    "password": "tajnehaslo"
  }'