@echo off
setlocal
cd /d "%~dp0.."
node automation\gallery_server.mjs start
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Gallery server exited with error code %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)
endlocal
