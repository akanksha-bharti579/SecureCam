# One-click demo start: registry server in its own window, phone linked over USB, verifier opened.
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File start_demo.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$adb = "C:\SDK\platform-tools\adb.exe"

# 1. Registry server (skip if one is already listening on 8787)
if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Registry server already running on port 8787"
} else {
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; node registry-server\server.js"
    Write-Host "Started the registry server in a new window"
    Start-Sleep -Seconds 3
}
try {
    $h = Invoke-RestMethod -Uri "http://localhost:8787/api/health" -TimeoutSec 10
    Write-Host ("Registry OK: {0} records, {1} device keys on file, {2} Google roots" -f $h.records, $h.keys, $h.trustedRoots)
} catch {
    Write-Host "Registry not answering yet - look at the server window" -ForegroundColor Red
}

# 2. Phone over USB
$devices = & $adb devices | Select-String "\tdevice$"
if ($devices) {
    & $adb reverse tcp:8787 tcp:8787 | Out-Null
    Write-Host "Phone linked: $($devices.Line.Split("`t")[0]) (adb reverse tcp:8787 done)"
} else {
    Write-Host "No phone found. Plug in the S23, unlock it, allow USB debugging, then run this script again." -ForegroundColor Yellow
}

# 3. Verifier page
Start-Process "http://localhost:8787/"
Write-Host "Backup files: $HOME\Desktop\SecureCam demo"
