Invoke-RestMethod `
    -Method Get `
    -Uri "http://localhost:3002/allposts" | ConvertTo-Json -Depth 10