@echo off
cd /d "%~dp0"
git add -A
git status
echo.
set /p msg="Commit message: "
git commit -m "%msg%"
git push
echo.
pause
