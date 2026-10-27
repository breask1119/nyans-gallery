@echo off
chcp 65001 > nul
setlocal

cd /d "%~dp0.."

node "automation\nyans_runner.mjs" %*

set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% NEQ 0 (
    echo.
    echo [終了] エラーコード: %EXIT_CODE%
    pause
)

endlocal
exit /b %EXIT_CODE%
