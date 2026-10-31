@echo off
@chcp 65001 >nul
:: ==============================================================================
:: Mediary Scout Fast Dev Runner Launcher for Windows
:: Delegates to tools/runner/dev-server.mjs
:: ==============================================================================

node "%~dp0dev-server.mjs" %*
exit /b %ERRORLEVEL%
