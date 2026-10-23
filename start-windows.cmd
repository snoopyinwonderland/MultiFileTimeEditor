@echo off
setlocal
cd /d "%~dp0"
title Multiple File Date Time Editor

echo Starting Multiple File Date Time Editor...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %*
set "FDT_EXIT=%ERRORLEVEL%"

if not "%FDT_EXIT%"=="0" (
  echo.
  echo Startup failed. Please check the error message above.
  pause
)

exit /b %FDT_EXIT%
