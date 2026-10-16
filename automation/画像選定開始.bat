@echo off
chcp 65001 > nul
setlocal

echo.
echo ==================================
echo Miu Image Organizer
echo ==================================
echo.

if "%~1"=="" (
  echo 画像フォルダをこのBATへドラッグ＆ドロップしてください。
  echo.
  echo 例:
  echo .ai-work\artwork-inbox\美羽\日常写真テスト
  echo.
  pause
  exit /b 1
)

set "TARGET_FOLDER=%~1"

if not exist "%TARGET_FOLDER%\" (
  echo.
  echo [エラー]
  echo 指定されたフォルダが見つかりません。
  echo.
  echo %TARGET_FOLDER%
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"

echo 対象フォルダ:
echo %TARGET_FOLDER%
echo.
echo 画像選定を開始します...
echo.

node ".\.ai-work\image-organizer.mjs" --folder "%TARGET_FOLDER%"

set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo ----------------------------------
echo.

if not "%EXIT_CODE%"=="0" (
  echo 画像選定処理でエラーが発生しました。
  echo Exit code: %EXIT_CODE%
) else (
  echo 画像選定処理が終了しました。
)

echo.
pause

exit /b %EXIT_CODE%