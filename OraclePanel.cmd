@echo off
rem Starts Oracle Panel and opens it in the default browser. Close this window to stop it.
cd /d "%~dp0"
python -c "import paramiko" 2>nul || python -m pip install --user "paramiko>=3.4"
python panel.py %*
if errorlevel 1 pause
