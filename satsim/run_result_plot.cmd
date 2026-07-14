:: 示例命令: .\run_result_plot.cmd data/simulation_bundle_gw2_800sat_5ac_1gs_30s_busy.json result_player/plots_gw2_800sat_5ac_1gs_30s_busy
@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" (
    echo [ERROR] Python executable not found: "%PYTHON_EXE%"
    exit /b 1
)

set "INPUT_PATH=data/simulation_bundle_gw2_800sat_5ac_1gs_30s_busy.json"
if not "%~1"=="" set "INPUT_PATH=%~1"

if "%~2"=="" (
    for %%I in ("%INPUT_PATH%") do (
        set "INPUT_NAME=%%~nI"
    )
    set "OUTPUT_STEM=!INPUT_NAME!"
    if /i "!OUTPUT_STEM:~0,18!"=="simulation_bundle_" (
        set "OUTPUT_STEM=plots_!OUTPUT_STEM:~18!"
    ) else (
        set "OUTPUT_STEM=!OUTPUT_STEM!_plots"
    )
    set "OUTPUT_DIR=result_player/!OUTPUT_STEM!"
) else (
    set "OUTPUT_DIR=%~2"
)

echo [result_plot] input=%INPUT_PATH%
echo [result_plot] output_dir=%OUTPUT_DIR%
"%PYTHON_EXE%" result_player/result_plot.py --input "%INPUT_PATH%" --output-dir "%OUTPUT_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo [ERROR] result_plot failed with exit code %EXIT_CODE%
    exit /b %EXIT_CODE%
)

echo [OK] Plot PNG files written to %OUTPUT_DIR%
exit /b 0