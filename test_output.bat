`@echo off
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
        powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12