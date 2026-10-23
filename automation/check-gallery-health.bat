@echo off
setlocal
cd /d "%~dp0.."
node automation\gallery_server.mjs health
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Health check failed with code %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)
endlocal
