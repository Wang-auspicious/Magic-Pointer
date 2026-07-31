@echo off
setlocal
cd /d "%~dp0"
start "" pythonw -m app.main --background
