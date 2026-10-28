# Simple local server for testing (works without Node.js or Python).
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1
# Note: keep this file ASCII-only. Windows PowerShell 5.1 misreads UTF-8 without BOM.
param([int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 8000 }))

$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving on http://localhost:$Port/ (Ctrl+C to stop)"

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
  if ($path -eq '/') { $path = '/index.html' }
  $file = Join-Path $root ($path.TrimStart('/'))
  $full = [System.IO.Path]::GetFullPath($file)
  $res = $ctx.Response
  if ($full.StartsWith($root) -and (Test-Path $full -PathType Leaf)) {
    $ext = [System.IO.Path]::GetExtension($full).ToLower()
    $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
    $res.Headers.Add('Cache-Control', 'no-store')
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
  }
  $res.Close()
}
