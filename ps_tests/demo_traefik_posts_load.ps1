param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$UsersUrl = "http://localhost:3001",
  [string]$Username = "demo_user",
  [string]$Password = "demo_pass",
  [int]$PostsCount = 30
)

$registerBody = @{ username = $Username; password = $Password; displayName = "Demo User" } | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri "$UsersUrl/register" -ContentType "application/json" -Body $registerBody | Out-Null
} catch {
  Write-Host "[demo] register skipped or already exists"
}

$loginBody = @{ username = $Username; password = $Password } | ConvertTo-Json
$loginResponse = Invoke-RestMethod -Method Post -Uri "$UsersUrl/login" -ContentType "application/json" -Body $loginBody
$token = $loginResponse.token
if (-not $token) { throw "Login failed - token missing" }

for ($i = 1; $i -le $PostsCount; $i++) {
  $postBody = @{ text = "demo post #$i $(Get-Date -Format o)" } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/posts" -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body $postBody | Out-Null
  if ($i % 10 -eq 0) { Write-Host "posted: $i" }
}

Write-Host "[demo] done"
Invoke-RestMethod -Method Get -Uri "$BaseUrl/posts/instance" | ConvertTo-Json
