@echo off
setlocal
pushd "%~dp0"
node shot.js %*
set EXITCODE=%ERRORLEVEL%
popd
pause
exit /b %EXITCODE%
