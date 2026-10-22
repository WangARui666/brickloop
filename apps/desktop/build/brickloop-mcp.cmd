@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0Brickloop.exe" "%~dp0resources\app.asar\out\main\mcp-shim.js" %*
