@echo off
chcp 65001 >nul
set "PATH=C:\Program Files\Git\cmd;C:\Program Files\GitHub CLI;%USERPROFILE%\.cargo\bin;%PATH%"
title My View - Release auf GitHub veroeffentlichen
echo ========================================================
echo   Erstelle Tauri + Electron Updates und veroeffentliche...
echo ========================================================
echo.
taskkill /IM my_view_app.exe /F >nul 2>&1
cargo build --release --manifest-path src-tauri\Cargo.toml
if %errorlevel% neq 0 (
    echo [FEHLER] Tauri Release-Build fehlgeschlagen!
    pause
    exit /b 1
)
call npm run build:update
if not exist "dist\app.asar" (
    echo [FEHLER] dist\app.asar konnte nicht erstellt werden!
    pause
    exit /b 1
)
if not exist "src-tauri\target\release\my_view_app.exe" (
    echo [FEHLER] src-tauri\target\release\my_view_app.exe nicht gefunden!
    pause
    exit /b 1
)

echo.
set /p VERSION="Gib die Versionsnummer ein (z. B. v1.1.1): "
if "%VERSION%"=="" set VERSION=v1.1.1

set /p TITLE="Gib einen Titel ein (z. B. Update %VERSION%): "
if "%TITLE%"=="" set TITLE=Update %VERSION%

set /p NOTES="Gib kurze Update-Notizen ein: "
if "%NOTES%"=="" set NOTES=Fehlerbehebungen und Verbesserungen.

echo.
echo Lade Release hoch nach https://github.com/tobiaslechert445-gif/Video-App ...
"C:\Program Files\GitHub CLI\gh.exe" release create %VERSION% "src-tauri\target\release\my_view_app.exe" "dist\app.asar" --repo tobiaslechert445-gif/Video-App --title "%TITLE%" --notes "%NOTES%"

if %errorlevel% equ 0 (
    echo.
    echo ========================================================
    echo  [ERFOLG] Das Update %VERSION% ist jetzt online!
    echo  Beide Varianten (Tauri .exe + Electron .asar) aktualisieren sich ab sofort automatisch!
    echo ========================================================
) else (
    echo.
    echo [FEHLER] Upload fehlgeschlagen.
)
pause
