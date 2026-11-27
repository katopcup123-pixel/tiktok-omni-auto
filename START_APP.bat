@echo off
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
echo Starting TikTok Omni Auto...
start "" http://localhost:3456
node src/server.js
pause
