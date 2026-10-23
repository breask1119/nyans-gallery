@echo off
setlocal
cd /d "%~dp0.."
node automation\postiz_status_sync.mjs --all
endlocal
