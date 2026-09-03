@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Tube AutoPilot - Instalador

echo ========================================
echo   TUBE AUTOPILOT - INSTALADOR FACIL
echo ========================================
echo.

rem Tenta localizar Node no PATH ou nos locais comuns do Windows
where node >nul 2>nul
if not errorlevel 1 goto NODE_OK

if exist "%ProgramFiles%\nodejs\node.exe" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  goto NODE_OK
)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
  goto NODE_OK
)

echo Node.js nao foi encontrado.
echo.
echo Vou tentar instalar o Node.js LTS automaticamente pelo Windows.
echo.
where winget >nul 2>nul
if errorlevel 1 goto SEM_WINGET

winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto FALHA_NODE

rem Atualiza PATH para esta janela apos a instalacao
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo O Node foi instalado, mas o Windows ainda nao atualizou o PATH.
  echo Feche TODAS as janelas do VS Code e execute este arquivo novamente.
  pause
  exit /b 0
)

:NODE_OK
echo Node encontrado:
node --version
echo NPM encontrado:
call npm --version
echo.

if not exist ".env" (
  if exist ".env.example" copy /y ".env.example" ".env" >nul
)

echo Instalando dependencias do projeto...
call npm install
if errorlevel 1 goto FALHA_NPM

echo.
echo ========================================
echo   INSTALACAO CONCLUIDA
echo ========================================
echo.
echo Agora abra o arquivo .env no VS Code.
echo Depois de configurar o Google, execute INICIAR.bat.
echo.
pause
exit /b 0

:SEM_WINGET
echo.
echo Nao encontrei o Winget neste Windows.
echo Abra: https://nodejs.org/
echo Instale a versao LTS do Node.js e reinicie o VS Code.
pause
exit /b 1

:FALHA_NODE
echo.
echo A instalacao automatica do Node falhou.
echo Abra: https://nodejs.org/
echo Instale a versao LTS e reinicie o computador ou o VS Code.
pause
exit /b 1

:FALHA_NPM
echo.
echo O Node esta funcionando, mas npm install falhou.
echo Copie o erro mostrado acima e me envie.
pause
exit /b 1
