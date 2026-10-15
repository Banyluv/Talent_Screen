<#
.SYNOPSIS
  Start (or stop) the TalentScreen API and web app locally on Windows, without Docker.

.DESCRIPTION
  Runs the FastAPI backend (uvicorn, in-process CV evaluation) and the Vite dev
  server side by side, writing logs to .logs/ at the repo root.

  Prerequisites:
    * PostgreSQL reachable at $DbUrl with a "talentscreen" role/database
    * Python dependencies installed (pip install -r apps/api/requirements.txt)
    * Web dependencies installed (npm install in apps/web)

  The app reads configuration from environment variables only (it does not load
  a .env file), so this script exports everything the API needs. Note the DSN
  uses 127.0.0.1 on purpose: "localhost" resolves to ::1, which many local
  PostgreSQL installs authenticate differently from IPv4.

.EXAMPLE
  ./scripts/dev-windows.ps1                 # start API :8000 + web :5173
  ./scripts/dev-windows.ps1 -Seed           # run migrations + seed demo data, then start
  ./scripts/dev-windows.ps1 -Stop           # stop both
  ./scripts/dev-windows.ps1 -ApiPort 8100 -WebPort 5174
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$Seed,
    [int]$ApiPort = 8000,
    [int]$WebPort = 5173,
    [string]$DbUrl = 'postgresql://talentscreen@127.0.0.1:5432/talentscreen',
    [string]$PublicUrl = 'http://localhost:5173'
)

$ErrorActionPreference = 'Stop'

$repo   = Split-Path -Parent $PSScriptRoot        # scripts/.. -> repo root
$apiDir = Join-Path $repo 'apps/api'
$webDir = Join-Path $repo 'apps/web'
$logDir = Join-Path $repo '.logs'

# Prefer the repo virtualenv; fall back to whatever "python" is on PATH.
$python = Join-Path $repo '.venv/Scripts/python.exe'
if (-not (Test-Path $python)) { $python = 'python' }

function Get-TrackedPid([string]$name) {
    $file = Join-Path $logDir "$name.pid"
    if (Test-Path $file) { return [int](Get-Content $file) }
    return 0
}

function Stop-App([string]$name, [int]$port) {
    $stopped = $false
    $procId = Get-TrackedPid $name
    if ($procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
        Kill-Tree $procId   # /T also stops npm's node/vite children
        $stopped = $true
    }
    # Fall back to whoever holds the port, in case the pid file is stale or was never written.
    $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($owner in $owners) {
        if ($owner -and $owner -ne 0) {
            Kill-Tree $owner
            $stopped = $true
        }
    }
    if ($stopped) { Write-Host "Stopped $name (port $port)" } else { Write-Host "$name is not running" }
    Remove-Item (Join-Path $logDir "$name.pid") -ErrorAction SilentlyContinue
}

function Kill-Tree([int]$procId) {
    # taskkill prints "ERROR:" to stderr when a child has already exited; that
    # harmless message must not abort the script while ErrorActionPreference=Stop.
    # Route it through cmd with all output discarded so PowerShell sees nothing.
    & $env:ComSpec /c "taskkill /PID $procId /T /F >nul 2>&1" | Out-Null
}

if ($Stop) {
    Stop-App 'api' $ApiPort
    Stop-App 'web' $WebPort
    return
}

New-Item -ItemType Directory -Force $logDir | Out-Null

# Load an optional repo-root .env (KEY=VALUE lines) so SMTP_* and other settings
# apply without editing this script. The explicit values below still win.
$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $eq = $line.IndexOf('=')
            if ($eq -gt 0) {
                $key = $line.Substring(0, $eq).Trim()
                $val = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
                if ($key) { Set-Item -Path "Env:$key" -Value $val }
            }
        }
    }
}

$dbDefault = 'postgresql://talentscreen@127.0.0.1:5432/talentscreen'
$env:DATABASE_URL    = if ($DbUrl -ne $dbDefault) { $DbUrl } elseif ($env:DATABASE_URL) { $env:DATABASE_URL } else { $dbDefault }
$env:API_PORT        = "$ApiPort"
$env:PUBLIC_URL      = $PublicUrl
$env:FRONTEND_URL    = $PublicUrl
$env:CORS_ORIGINS    = "http://localhost:$WebPort,http://localhost:8080"
$env:COOKIE_SAMESITE = 'lax'
$env:EVALUATE_INLINE = 'true'   # the API evaluates CVs in-process, so no worker is needed
$env:VITE_API_URL    = "http://localhost:$ApiPort"   # keep the dev server pointed at this API port

# Re-running while a previous instance is still up would make the new API fail
# with "address already in use". Restart cleanly instead.
$running = @(Get-NetTCPConnection -LocalPort $ApiPort, $WebPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -and $_ -ne 0 })
if ($running) {
    Write-Host 'A previous instance is still running on the API/web ports; stopping it first...'
    Stop-App 'api' $ApiPort
    Stop-App 'web' $WebPort
    Start-Sleep -Seconds 1
}

if ($Seed) {
    $env:SEED_DEMO_DATA = 'true'
}
Write-Host 'Applying migrations...'
Push-Location $apiDir
try {
    # Run through cmd so Python's stderr logging is merged into stdout; PowerShell 5.1
    # would otherwise surface every log line as a terminating error.
    & $env:ComSpec /c "`"$python`" -m app.migrate 2>&1"
    if ($LASTEXITCODE -ne 0) { throw 'Migrations failed' }
} finally { Pop-Location }
Remove-Item Env:SEED_DEMO_DATA -ErrorAction SilentlyContinue

Write-Host "Starting API on :$ApiPort (logs: .logs/api.log)..."
$api = Start-Process -FilePath $python -ArgumentList '-m', 'app.main' -WorkingDirectory $apiDir `
    -RedirectStandardOutput (Join-Path $logDir 'api.log') `
    -RedirectStandardError (Join-Path $logDir 'api.err.log') `
    -WindowStyle Hidden -PassThru
$api.Id | Set-Content (Join-Path $logDir 'api.pid')

Write-Host "Starting web on :$WebPort (logs: .logs/web.log)..."
$web = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory $webDir `
    -RedirectStandardOutput (Join-Path $logDir 'web.log') `
    -RedirectStandardError (Join-Path $logDir 'web.err.log') `
    -WindowStyle Hidden -PassThru
$web.Id | Set-Content (Join-Path $logDir 'web.pid')

function Wait-ForHttp([string]$url, [int]$timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

Write-Host ''
Write-Host "  Web app  : http://localhost:$WebPort"
Write-Host "  API docs : http://localhost:$ApiPort/api/docs"
Write-Host '  Sign in  : admin@ecews.local / Admin-Password-2026'
Write-Host '             demo users, e.g. hr.admin@demo.ecews.local / Demo-Password-2026'
Write-Host ''

$apiUp = Wait-ForHttp "http://localhost:$ApiPort/api/auth/providers"
$webUp = Wait-ForHttp "http://localhost:$WebPort"

if ($apiUp -and $webUp) {
    Write-Host 'Both the API and the web app are up and responding.' -ForegroundColor Green
} else {
    Write-Host 'Startup did not complete cleanly:' -ForegroundColor Red
    if (-not $apiUp) {
        Write-Host '  API is not responding — last lines of .logs/api.err.log:'
        if (Test-Path (Join-Path $logDir 'api.err.log')) { Get-Content (Join-Path $logDir 'api.err.log') -Tail 15 }
    }
    if (-not $webUp) {
        Write-Host '  Web app is not responding — last lines of .logs/web.err.log:'
        if (Test-Path (Join-Path $logDir 'web.err.log')) { Get-Content (Join-Path $logDir 'web.err.log') -Tail 15 }
    }
}
Write-Host ''
Write-Host 'Stop with: ./scripts/dev-windows.ps1 -Stop'
