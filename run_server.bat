@echo off
echo Starting Perceive Backend Server...
cd /d "%~dp0backend"
if exist venv\Scripts\activate.bat (
    call venv\Scripts\activate.bat
)
uvicorn main:app --reload --host 127.0.0.1 --port 8000
pause
