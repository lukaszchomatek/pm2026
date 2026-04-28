$body = @{
    username = "lukas2"
    password = "haslohaslo"
} | ConvertTo-Json

$loginResponse = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3001/login" `
    -ContentType "application/json" `
    -Body $body

$token = $loginResponse.token
$token

$body = @{
    text = "Docker is sooooooo good!"
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3002/posts" `
    -ContentType "application/json" `
    -Headers @{ Authorization = "Bearer $token" } `
    -Body $body