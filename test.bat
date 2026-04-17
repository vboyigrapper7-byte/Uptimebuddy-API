@echo off
setlocal enabledelayedexpansion

echo starting
if 1 neq 0 (
    echo [INFO] Node.js not found. Installing Node.js automatically...
    if 1 neq 0 (
        echo [INFO] Winget not found.
        powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.12.2/node-v20.12.2-x64.msi' -OutFile '%temp%\\nodejs.msi'"
    )
)
echo done
