@echo off
setlocal enabledelayedexpansion

:: ── Elevation Check & Auto-Elevate ───────────────────────────────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting Administrative Privileges...
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\\getadmin.vbs"
    echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\\getadmin.vbs"
    cscript //nologo "%temp%\\getadmin.vbs"
    del "%temp%\\getadmin.vbs"
    exit /b
)

echo Starting Monitor Hub Agent Setup...
echo.

:: ── Directory Setup ────────────────────────────────────────────────────────
mkdir "%USERPROFILE%\\monitorhub-agent" 2>nul
cd /d "%USERPROFILE%\\monitorhub-agent"

:: ── Verify Node.js ─────────────────────────────────────────────────────────
node -v >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Node.js not found. Installing Node.js automatically...
    winget -v >nul 2>&1
    if !errorLevel! equ 0 (
        echo [INFO] Using winget...
        winget install -e --id OpenJS.NodeJS --accept-package-agreements --accept-source-agreements --silent
    ) else (
        echo [INFO] Winget not found. Downloading standalone MSI installer...
        powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.12.2/node-v20.12.2-x64.msi' -OutFile '%temp%\\nodejs.msi'"
        echo [INFO] Installing Node.js ^(this may take 1-2 minutes^)...
        msiexec.exe /i "%temp%\\nodejs.msi" /qn /norestart
        del "%temp%\\nodejs.msi"
    )
    :: NOTE: winget can return non-zero exit codes for informational prompts
    :: (e.g. MSStore terms^), so we DO NOT check errorLevel here.
    :: Instead, we refresh PATH from the registry and retest node.
    echo [INFO] Refreshing environment PATH...
    for /f "skip=2 tokens=3*" %%A in ('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v "Path" 2^>nul') do set "MACHINE_PATH=%%A %%B"
    for /f "skip=2 tokens=3*" %%A in ('reg query "HKCU\\Environment" /v "Path" 2^>nul') do set "USER_PATH=%%A %%B"
    if defined MACHINE_PATH (
        if defined USER_PATH (
            set "PATH=!MACHINE_PATH!;!USER_PATH!"
        ) else (
            set "PATH=!MACHINE_PATH!"
        )
    ) else (
        set "PATH=%PATH%;C:\\Program Files\\nodejs"
    )
    :: Verify node is now available
    node -v >nul 2>&1
    if !errorLevel! neq 0 (
        echo [ERROR] Node.js could not be detected after install.
        echo Please restart this script, or install Node.js manually from https://nodejs.org/
        pause
        exit /b 1
    )
    echo [INFO] Node.js installed and detected successfully.
)

:: ── Dependency Installation ────────────────────────────────────────────────
call npm init -y >nul
echo Installing local dependencies (axios, dotenv, systeminformation, node-windows)...
call npm install axios dotenv systeminformation node-windows --quiet

:: ── Fetch Agent Script & Service Installer ─────────────────────────────────
echo Connecting to platform: http://localhost:3001
echo (This may take up to 60 seconds if the server is waking from sleep...)
curl.exe --retry 5 --retry-delay 10 --retry-all-errors --connect-timeout 30 --max-time 120 -o agent.js "http://localhost:3001/api/v1/agents/script"
curl.exe --retry 5 --retry-delay 10 --retry-all-errors --connect-timeout 30 --max-time 120 -o service.js "http://localhost:3001/api/v1/agents/windows-service.js"
if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Could not download agent from Monitor Hub Platform!
    echo Ensure this server can reach http://localhost:3001
    echo If using Render free tier, the backend may still be waking up.
    echo Wait 60 seconds and re-run this script.
    echo.
    pause
    exit /b 1
)

:: ── Environment Setup ──────────────────────────────────────────────────────
echo AGENT_TOKEN=TEST_TOKEN> .env
echo INGEST_URL=http://localhost:3001/api/v1/agents/ingest>> .env
echo REPORT_INTERVAL_MS=30000>> .env

:: ── Windows Service Management (node-windows) ──────────────────────────────
echo Installing and starting Native Windows Service...
node service.js

echo.
echo ========================================================
echo  Agent Configuration Upgraded!
echo  Telemetry: Running natively as a Windows System Service
echo  Auth Mode: Secure Headers
echo ========================================================
echo.
echo View service status in Windows "Services.msc" (MonitorHubAgent)
echo.
pause
