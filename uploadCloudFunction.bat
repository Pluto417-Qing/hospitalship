@echo off
setlocal EnableExtensions EnableDelayedExpansion

if not "%~1"=="" set "CLOUD_ENV_ID=%~1"

if "%CLOUD_ENV_ID%"=="" (
  echo Usage: %~nx0 ^<cloud-environment-id^>
  echo Or set CLOUD_ENV_ID before running this script.
  exit /b 1
)

if /I not "%CLOUD_SECURITY_CONFIRMED_ENV%"=="%CLOUD_ENV_ID%" (
  echo Deployment stopped: verify all database collections are ADMINONLY and
  echo apply cloud function and storage rules in the target environment.
  echo After verification, set CLOUD_SECURITY_CONFIRMED_ENV=%CLOUD_ENV_ID%
  echo and run again in the same shell.
  exit /b 1
)

call node "%~dp0scripts\validate-deployment-target.js" "%CLOUD_ENV_ID%"
if errorlevel 1 (
  echo Deployment stopped because the client environment does not match.
  exit /b 1
)

call npm --prefix "%~dp0." test
if errorlevel 1 (
  echo Deployment stopped because local checks failed.
  exit /b 1
)

if "%WECHAT_CLI%"=="" set "WECHAT_CLI=cli"
for %%I in ("%~dp0.") do set "PROJECT_ROOT=%%~fI"

if exist "%WECHAT_CLI%" (
  for %%I in ("%WECHAT_CLI%") do set "WECHAT_CLI_PATH=%%~fI"
) else (
  for /f "delims=" %%I in ('where.exe "%WECHAT_CLI%" 2^>nul') do (
    if not defined WECHAT_CLI_PATH set "WECHAT_CLI_PATH=%%I"
  )
)

if not defined WECHAT_CLI_PATH (
  echo WeChat CLI not found: %WECHAT_CLI%
  echo Add cli.bat to PATH or set WECHAT_CLI to its full path.
  exit /b 1
)

call powershell.exe -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0scripts\deploy-cloud-functions.ps1" ^
  -EnvId "%CLOUD_ENV_ID%" ^
  -WeChatCli "!WECHAT_CLI_PATH!" ^
  -ProjectRoot "%PROJECT_ROOT%"
if errorlevel 1 (
  echo Cloud function deployment stopped because success was not confirmed.
  exit /b 1
)

echo All cloud functions deployed successfully.
exit /b 0
