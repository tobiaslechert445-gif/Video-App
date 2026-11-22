@echo off
chcp 65001 >nul
title My View - Update Paket erstellen
echo ===================================================
echo   Erstelle kompakte Update-Datei (app.asar)...
echo ===================================================
echo.
npm run build:update
echo.
if exist "dist\app.asar" (
    echo ===================================================
    echo  [ERFOLG] Die Update-Datei wurde erstellt!
    echo  Ort: dist\app.asar
    echo.
    echo  Diese Datei kannst du jetzt:
    echo  1. Auf GitHub unter Releases als Asset hochladen, ODER
    echo  2. Direkt deinem Freund per Discord schicken!
    echo ===================================================
) else (
    echo [FEHLER] dist\app.asar konnte nicht gefunden werden.
)
pause
