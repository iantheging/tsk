@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   tsk needs Node.js. Install it from https://nodejs.org  ^(LTS is fine^)
  echo.
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause