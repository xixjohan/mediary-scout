@echo off
setlocal enabledelayedexpansion
title Mediary Scout Smoke Tester

cd /d "%~dp0"

echo.
echo ======================================================
echo    Mediary Scout - E2E Core Smoke Tester
echo ======================================================
echo.

node tools/runner/smoke-tester.mjs %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Smoke test failed with exit code %ERRORLEVEL%.
    exit /b %ERRORLEVEL%
)

exit /b 0
