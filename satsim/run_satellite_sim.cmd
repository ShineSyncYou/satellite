:: 示例命令: .\run_satellite_sim.cmd data/sample_config_gw2_800sat_5ac_1gs_30s_seam.json data/simulation_bundle_gw2_800sat_5ac_1gs_30s_seam.json
@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" (
    echo [ERROR] Python executable not found: "%PYTHON_EXE%"
    exit /b 1
)

set "CONFIG_PATH=data/sample_config_gw2_800sat_5ac_1gs_30s_busy.json"
if not "%~1"=="" set "CONFIG_PATH=%~1"

if "%~2"=="" (
    for %%I in ("%CONFIG_PATH%") do (
        set "CONFIG_DIR=%%~dpI"
        set "CONFIG_NAME=%%~nI"
        set "CONFIG_EXT=%%~xI"
    )
    set "OUTPUT_NAME=!CONFIG_NAME!"
    if /i "!OUTPUT_NAME:~0,14!"=="sample_config_" (
        set "OUTPUT_NAME=simulation_bundle_!OUTPUT_NAME:~14!"
    ) else (
        set "OUTPUT_NAME=simulation_bundle_!OUTPUT_NAME!"
    )
    set "OUTPUT_PATH=!CONFIG_DIR!!OUTPUT_NAME!!CONFIG_EXT!"
) else (
    set "OUTPUT_PATH=%~2"
)

echo [satellite_sim] config=%CONFIG_PATH%
echo [satellite_sim] output=%OUTPUT_PATH%
"%PYTHON_EXE%" -m satellite_sim.main --config "%CONFIG_PATH%" --output "%OUTPUT_PATH%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] satellite_sim failed with exit code %EXIT_CODE%
    exit /b %EXIT_CODE%
)

echo [OK] Simulation bundle written to %OUTPUT_PATH%
exit /b 0