@echo off
cd /d "%~dp0"
if not exist data mkdir data
if not exist data\runtime mkdir data\runtime
echo [%date% %time%] start magic pointer >> data\runtime\electron_launcher.log
if exist node_modules\electron\dist\electron.exe (
  echo [%date% %time%] electron runtime found >> data\runtime\electron_launcher.log
  npm.cmd run overlay >> data\runtime\electron_launcher.log 2>&1
) else (
  echo [%date% %time%] electron runtime missing; fallback to python app.main >> data\runtime\electron_launcher.log
  py -3 -m app.main --background >> data\runtime\electron_launcher.log 2>&1
  if errorlevel 1 python -m app.main --background >> data\runtime\electron_launcher.log 2>&1
)
