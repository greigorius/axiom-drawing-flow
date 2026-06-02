@echo off
cd /d "%~dp0"
git add -A
git status
echo.
set "default=Update %date% %time:~0,5%"
set /p msg="Commit message (Enter for default): "
if "%msg%"=="" set "msg=%default%"
git commit -m "%msg%"
git push origin main
echo.
pause
