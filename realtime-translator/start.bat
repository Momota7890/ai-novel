@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "PYTHONUTF8=1"
set "HF_HUB_DISABLE_SYMLINKS_WARNING=1"
set "VENV_PYTHON=%~dp0backend\.venv\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
    echo [ERROR] Python virtual environment not found: "%VENV_PYTHON%"
    echo.
    echo Run one-time setup from realtime-translator\ in PowerShell:
    echo   python -m venv --system-site-packages backend\.venv
    echo   .\backend\.venv\Scripts\pip.exe install -r backend\requirements.txt
    echo.
    echo See docs\SETUP.md for full instructions.
    pause
    exit /b 1
)

if not exist "%~dp0.env" (
    if exist "%~dp0.env.example" (
        echo [INFO] Creating .env from .env.example...
        copy /y "%~dp0.env.example" "%~dp0.env" >nul
    )
)

set "HF_HOME=D:\hf_cache"
set "SERVER_HOST=127.0.0.1"
set "SERVER_PORT=8765"

if exist "%~dp0.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
        set "KEY=%%A"
        set "VAL=%%B"
        if not "!KEY!"=="" if not "!KEY:~0,1!"=="#" (
            if /i "!KEY!"=="HF_HOME" if not "!VAL!"=="" set "HF_HOME=!VAL!"
            if /i "!KEY!"=="SERVER_HOST" if not "!VAL!"=="" set "SERVER_HOST=!VAL!"
            if /i "!KEY!"=="SERVER_PORT" if not "!VAL!"=="" set "SERVER_PORT=!VAL!"
        )
    )
)

if not exist "%HF_HOME%" (
    mkdir "%HF_HOME%" 2>nul
)

echo ================================================================
echo  Realtime EN-^>TH Novel ^& Manhwa Translator (100%% Local GPU)
echo ================================================================
echo  API URL  : http://%SERVER_HOST%:%SERVER_PORT%
echo  Health   : http://%SERVER_HOST%:%SERVER_PORT%/health
echo  HF Cache : %HF_HOME%
echo.
echo  - Starts with 0 GB VRAM (lazy-loads on first translation).
echo  - Auto-unloads GPU VRAM after idle timeout (default 15 min).
echo  - Press Ctrl+C or close this window to stop and free GPU VRAM.
echo ================================================================
echo.

"%VENV_PYTHON%" -m uvicorn app.main:app --app-dir backend --host %SERVER_HOST% --port %SERVER_PORT%
if errorlevel 1 (
    echo.
    echo [ERROR] Server stopped unexpectedly. Check if port %SERVER_PORT% is already in use.
    pause
)
endlocal
