@echo off
cd /d "%~dp0"
echo Starting Axiom Drawing Flow dev server...
start "" http://localhost:3000
node server.js
