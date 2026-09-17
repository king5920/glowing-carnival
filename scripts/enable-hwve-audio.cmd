@echo off
REM Restore Huawei HWVE Audio APO service (undo disable-hwve-audio.cmd)
REM Right-click this file -> Run as administrator
echo [JARVIS] Enabling HWVEAudioService auto-start ...
sc config HWVEAudioService start= auto
echo [JARVIS] Starting HWVEAudioService ...
sc start HWVEAudioService
echo.
echo [JARVIS] Current status:
sc query HWVEAudioService
echo.
echo [JARVIS] Restored. Huawei audio effects are back on.
pause
