@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Tube AutoPilot

where node >nul 2>nul
if not errorlevel 1 goto NODE_OK
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado.
  echo Execute primeiro INSTALAR-FACIL.bat
  pause
  exit /b 1
)

:NODE_OK
if not exist "node_modules" (
  echo Dependencias nao instaladas. Execute primeiro INSTALAR-FACIL.bat
  pause
  exit /b 1
)

echo Iniciando Tube AutoPilot...
echo Abra no navegador: http://localhost:3000
echo.
call npm run dev
pause
