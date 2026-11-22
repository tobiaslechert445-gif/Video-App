/*
 * Delay-Load-Hook fuer native Electron-Addons unter Windows
 * (entspricht node-gyp/src/win_delay_load_hook.cc).
 *
 * node.lib importiert alle N-API-Symbole aus "node.exe". In Electron heisst
 * der Host-Prozess aber "electron.exe" bzw. "My View.exe". Ohne diesen Hook
 * versucht Windows beim ersten N-API-Aufruf eine fremde node.exe zu laden
 * und der Prozess stuerzt ab. Der Hook leitet die Anfrage auf das bereits
 * laufende Host-Programm um, das die N-API-Funktionen selbst exportiert.
 */

#ifdef _MSC_VER

#pragma managed(push, off)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <delayimp.h>
#include <string.h>

#ifndef HOST_BINARY
#define HOST_BINARY "node.exe"
#endif

static FARPROC WINAPI load_exe_hook(unsigned int event, DelayLoadInfo* info) {
  HMODULE m;
  if (event != dliNotePreLoadLibrary)
    return NULL;

  if (_stricmp(info->szDll, HOST_BINARY) != 0)
    return NULL;

  m = GetModuleHandle(TEXT("libnode.dll"));
  if (m == NULL) m = GetModuleHandle(NULL);
  return (FARPROC) m;
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = load_exe_hook;

#pragma managed(pop)

#endif
