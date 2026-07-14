:: 示例命令: .\run_playback_3d.cmd data/simulation_bundle_gw2_800sat_5ac_1gs_30s_busy.json 35 0.55
@echo off
setlocal

cd /d "%~dp0"

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
set "BOOTSTRAP_PY="

where py >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "BOOTSTRAP_PY=py -3"
)

if not defined BOOTSTRAP_PY (
    where python >nul 2>nul
    if not errorlevel 1 (
        python -c "import sys" >nul 2>nul
        if not errorlevel 1 set "BOOTSTRAP_PY=python"
    )
)

set "NEED_REBUILD=0"
if not exist "%VENV_PY%" set "NEED_REBUILD=1"
if "%NEED_REBUILD%"=="0" (
    "%VENV_PY%" -c "import sys" >nul 2>nul
    if errorlevel 1 set "NEED_REBUILD=1"
)

if "%NEED_REBUILD%"=="1" (
    if not defined BOOTSTRAP_PY (
        echo [ERROR] Cannot create virtual environment: no bootstrap Python found.
        echo [ERROR] Install Python launcher or python executable and retry.
        exit /b 1
    )

    echo [INFO] Rebuilding virtual environment at .venv ...
    if exist "%~dp0.venv" rmdir /s /q "%~dp0.venv"
    %BOOTSTRAP_PY% -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create .venv
        exit /b 1
    )

    "%VENV_PY%" -m pip install --upgrade pip
    if errorlevel 1 (
        echo [ERROR] Failed to upgrade pip inside .venv
        exit /b 1
    )

    "%VENV_PY%" -m pip install -r requirements.txt -r result_player/requirements.txt
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies into .venv
        exit /b 1
    )
)

set "INPUT_PATH=data/simulation_bundle_gw2_800sat_5ac_1gs_30s_seam.json"
if not "%~1"=="" set "INPUT_PATH=%~1"

set "CONE_ANGLE_DEG=35"
if not "%~2"=="" set "CONE_ANGLE_DEG=%~2"

set "FRAME_INTERVAL=0.55"
if not "%~3"=="" set "FRAME_INTERVAL=%~3"

echo [playback_3d] input=%INPUT_PATH%
echo [playback_3d] cone_angle_deg=%CONE_ANGLE_DEG%
echo [playback_3d] frame_interval=%FRAME_INTERVAL%
echo [playback_3d] python=%VENV_PY%
"%VENV_PY%" result_player/playback_3d.py --input "%INPUT_PATH%" --cone-angle-deg "%CONE_ANGLE_DEG%" --frame-interval "%FRAME_INTERVAL%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] playback_3d failed with exit code %EXIT_CODE%
    exit /b %EXIT_CODE%
)

exit /b 0