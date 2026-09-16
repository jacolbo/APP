@echo off
REM Double-click this on Windows.
REM
REM Finds Node, makes a password the first time, starts the server and opens
REM the browser, so starting Pose Board is one action rather than a terminal
REM session.

cd /d "%~dp0"
echo.
echo   Pose Board
echo   ----------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed, and Pose Board needs it to run.
  echo.
  echo   Install it from https://nodejs.org ^(take the LTS version^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist data mkdir data
set "PASSWORD_FILE=data\studio-password.txt"

if not exist "%PASSWORD_FILE%" (
  REM Generated rather than asked for, so a first run cannot end up on
  REM "password". Edit the file to change it.
  node -e "process.stdout.write(require('crypto').randomBytes(9).toString('base64url'))" > "%PASSWORD_FILE%"
  echo   A studio password has been made for you:
  echo.
  type "%PASSWORD_FILE%"
  echo.
  echo.
  echo   It is saved in %PASSWORD_FILE% — edit that file to change it.
  echo.
)

set /p ADMIN_PASSWORD=<"%PASSWORD_FILE%"

echo   Starting on http://localhost:4000
echo   Sign in with the password in %PASSWORD_FILE%
echo   Close this window to stop.
echo.

start "" http://localhost:4000
node server.js
