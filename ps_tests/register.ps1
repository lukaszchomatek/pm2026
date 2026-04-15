$body = @{
    username = "lukas2"
    password = "haslohaslo"


} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3001/register" `
    -ContentType "application/json" `
    -Body $body