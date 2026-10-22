@echo off
rem Double-click to run masterapp on this PC. Needs Node.js 20 or newer.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing, first time only...
  call npm install
)
call npm run local
pause
