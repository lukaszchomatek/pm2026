Invoke-RestMethod `
    -Method Get `
    -Uri "http://localhost:3002/posts" | ConvertTo-Json -Depth 10