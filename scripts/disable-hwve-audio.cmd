@echo off
REM Disable Huawei HWVE Audio APO service (the one swallowing mic level for JARVIS voice wake)
REM Right-click this file -> Run as administrator
echo [JARVIS] Stopping HWVEAudioService ...
sc stop HWVEAudioService
echo [JARVIS] Disabling HWVEAudioService auto-start ...
sc config HWVEAudioService start= disabled
echo.
echo [JARVIS] Current status:
sc query HWVEAudioService
echo.
echo [JARVIS] Done. Mic level should now be normal. Reboot not required.
echo [JARVIS] To restore later: sc config HWVEAudioService start= auto  then  sc start HWVEAudioService
pause
