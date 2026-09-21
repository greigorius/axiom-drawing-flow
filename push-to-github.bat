@echo off
title Axiom Drawing Flow - Push to GitHub
cd /d "%~dp0"
echo.
echo  ================================================
echo   Axiom Drawing Flow - Push to GitHub
echo  ================================================
echo.

:: ---- Pre-push guard --------------------------------------------------------
:: drawing-flow.js is ~170 KB and has been truncated mid-file by AI edits before.
:: A syntax error there takes down every /api/df route on Netlify, and the build
:: itself will not catch it. Check before pushing, every time - not when you
:: remember to.
echo  Checking syntax...
call node --check drawing-flow.js
if errorlevel 1 (
    echo.
    echo  ABORTED: drawing-flow.js has a syntax error. Nothing was pushed.
    pause
    exit /b 1
)
call node --check app.js
if errorlevel 1 (
    echo.
    echo  ABORTED: app.js has a syntax error. Nothing was pushed.
    pause
    exit /b 1
)

echo  Running tests...
for %%T in (activity routes parsing) do (
    call node tests\%%T.test.js >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  ABORTED: tests\%%T.test.js failed. Nothing was pushed.
        echo  Run it directly to see why:  node tests\%%T.test.js
        pause
        exit /b 1
    )
    echo    ok  tests\%%T.test.js
)
echo.

:: ---- Commit message --------------------------------------------------------
::   wmic is gone from current Windows 11 builds, so the old date lookup returned nothing and
::   every default message came out as "Update ~0,4DT:~4,2DT:..." - see the git log from
::   18-21 Sep 2026. PowerShell ships with every supported Windows, and %date% covers the
::   case where even that is unavailable.
set "STAMP="
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set "STAMP=%%i"
if not defined STAMP set "STAMP=%date% %time:~0,5%"
set "DEFAULT_MSG=Update %STAMP%"
echo  Press Enter to use default: "%DEFAULT_MSG%"
set /p COMMIT_MSG=Enter commit message (or press Enter):
if "%COMMIT_MSG%"=="" set COMMIT_MSG=%DEFAULT_MSG%

:: ---- Stage -----------------------------------------------------------------
echo.
echo  Staging all changes...
git add -A
if errorlevel 1 (
    echo  ERROR: git add failed.
    pause
    exit /b 1
)
git status --short
echo.

:: ---- Commit ----------------------------------------------------------------
echo  Committing: "%COMMIT_MSG%"
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
    echo  Nothing to commit, or commit failed.
    pause
    exit /b 1
)

:: ---- Branch ----------------------------------------------------------------
set BRANCH=main
for /f "tokens=*" %%i in ('git rev-parse --abbrev-ref HEAD') do set CURRENT_BRANCH=%%i
if /i not "%CURRENT_BRANCH%"=="%BRANCH%" (
    echo  Switching from %CURRENT_BRANCH% to %BRANCH%...
    git checkout %BRANCH%
    if errorlevel 1 (
        echo  ERROR: Could not switch to %BRANCH%.
        pause
        exit /b 1
    )
    echo  Merging %CURRENT_BRANCH% into %BRANCH%...
    git merge %CURRENT_BRANCH% --no-ff -m "Merge %CURRENT_BRANCH% into %BRANCH%"
    if errorlevel 1 (
        echo  ERROR: Merge failed. Resolve conflicts and try again.
        pause
        exit /b 1
    )
)

:: ---- Push ------------------------------------------------------------------
echo  Pushing to GitHub...
git push origin %BRANCH%
if errorlevel 1 (
    echo  ERROR: Push failed. Check your connection or credentials.
    pause
    exit /b 1
)

echo.
echo  ================================================
echo   Done - pushed to origin/%BRANCH%
echo   Netlify will pick it up and redeploy.
echo  ================================================
echo.
pause
