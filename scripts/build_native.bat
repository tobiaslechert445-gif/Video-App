@echo off
setlocal EnableDelayedExpansion

rem ============================================================
rem  PhotoCraft C++ Engine - Build fuer Electron (MSVC x64)
rem  Aufruf:  npm run build:native
rem ============================================================

set "ROOT=%~dp0.."
pushd "%ROOT%"

rem --- 1. Visual Studio (MSVC) automatisch finden -------------
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [ERROR] vswhere.exe nicht gefunden. Ist Visual Studio mit "Desktopentwicklung mit C++" installiert?
    popd & exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH (
    echo [ERROR] Keine Visual-Studio-Installation mit C++ Compiler gefunden.
    popd & exit /b 1
)
echo [C++ Build] Visual Studio: !VSPATH!
call "!VSPATH!\VC\Auxiliary\Build\vcvars64.bat" > nul
if errorlevel 1 (
    echo [ERROR] MSVC-Umgebung konnte nicht initialisiert werden.
    popd & exit /b 1
)

rem --- 2. Electron-Version ermitteln & Header laden -----------
for /f "usebackq tokens=*" %%v in (`node -p "require('./node_modules/electron/package.json').version"`) do set "ELECTRON_VER=%%v"
if not defined ELECTRON_VER (
    echo [ERROR] Electron-Version konnte nicht ermittelt werden. Wurde "npm install" ausgefuehrt?
    popd & exit /b 1
)
echo [C++ Build] Ziel: Electron !ELECTRON_VER!

set "HDR_DIR=%LOCALAPPDATA%\node-gyp\Cache\!ELECTRON_VER!"
if not exist "!HDR_DIR!\x64\node.lib" (
    echo [C++ Build] Lade Electron-Header herunter...
    call npx --yes node-gyp install --target=!ELECTRON_VER! --dist-url=https://electronjs.org/headers
    if errorlevel 1 (
        echo [ERROR] Header-Download fehlgeschlagen.
        popd & exit /b 1
    )
)

set "NODE_INC=!HDR_DIR!\include\node"
set "NODE_LIB=!HDR_DIR!\x64\node.lib"
for /f "usebackq tokens=*" %%n in (`node -p "require('node-addon-api').include_dir"`) do set "NAPI_INC=%%n"

if not exist "build\Release" mkdir "build\Release"

rem --- 3. Kompilieren -----------------------------------------
echo [C++ Build] Kompiliere C++ Quellen (MSVC /O2 /std:c++17)...
cl /nologo /c /O2 /Oi /GL- /MT /EHsc /std:c++17 /W3 ^
   /DNAPI_CPP_EXCEPTIONS /DNAPI_VERSION=8 /DBUILDING_NODE_EXTENSION /DHOST_BINARY=\"node.exe\" ^
   /D_CRT_SECURE_NO_WARNINGS /DNOMINMAX ^
   -I"!NODE_INC!" -I"!NAPI_INC!" ^
   native\brush_engine.cpp ^
   native\pixel_ops.cpp ^
   native\adjustments.cpp ^
   native\filters.cpp ^
   native\binding.cpp ^
   native\win_delay_load_hook.cc ^
   /Fo"build\Release\\"
if errorlevel 1 (
    echo [ERROR] Kompilierung fehlgeschlagen.
    popd & exit /b 1
)

rem --- 4. Linken (mit Delay-Load fuer node.exe -> Electron) ---
echo [C++ Build] Linke brush_engine_native.node ...
link /nologo /DLL /OUT:"build\Release\brush_engine_native.node" ^
     build\Release\brush_engine.obj ^
     build\Release\pixel_ops.obj ^
     build\Release\adjustments.obj ^
     build\Release\filters.obj ^
     build\Release\binding.obj ^
     build\Release\win_delay_load_hook.obj ^
     "!NODE_LIB!" delayimp.lib /DELAYLOAD:node.exe
if errorlevel 1 (
    echo [ERROR] Linken fehlgeschlagen.
    popd & exit /b 1
)

del /q build\Release\*.obj build\Release\*.exp build\Release\*.lib 2>nul

echo [C++ Build] ERFOLG: build\Release\brush_engine_native.node
popd
exit /b 0
