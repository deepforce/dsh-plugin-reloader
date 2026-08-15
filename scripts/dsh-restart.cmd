@echo off
rem dsh-restart.cmd - run dsh web, auto-restart when plugin-reloader signals a
rem dependency change (exit code 42 by default).
rem
rem Usage: dsh-restart.cmd [dsh web args...]
setlocal
:loop
call dsh.cmd web %*
if %ERRORLEVEL% EQU 42 (
  echo [plugin-reloader] dependency change detected - restarting dsh...
  goto loop
)
exit /b %ERRORLEVEL%
