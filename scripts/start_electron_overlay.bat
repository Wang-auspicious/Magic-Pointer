@echo off
setlocal
cd /d "%~dp0.."
if not exist data mkdir data
if not exist data\runtime mkdir data\runtime
echo [%date% %time%] start magic pointer >> data\runtime\electron_launcher.log
REM Always stop stale background instances first, otherwise old Electron JS keeps running.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_magic_pointer.ps1" >> data\runtime\electron_launcher.log 2>&1
if exist node_modules\electron\dist\electron.exe (
  echo [%date% %time%] electron runtime found >> data\runtime\electron_launcher.log
  npm.cmd run overlay >> data\runtime\electron_launcher.log 2>&1
) else (
  echo [%date% %time%] electron runtime missing; run npm install first >> data\runtime\electron_launcher.log
  exit /b 1
)
