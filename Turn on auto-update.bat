@echo off
title Auto JPG - auto-update
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0updater\install.ps1"
pause
