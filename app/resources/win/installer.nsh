; electron-builder NSIS include (nsis.include): per-user extras on top of its install/uninstall sections.
; Everything goes to HKCU / %LOCALAPPDATA%, so the installer never needs admin rights.

!macro customInstall
  ; visioncli:// links open the app (the app also calls setAsDefaultProtocolClient; this covers it before first run).
  WriteRegStr HKCU "Software\Classes\visioncli" "" "URL:VisionCLI"
  WriteRegStr HKCU "Software\Classes\visioncli" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\visioncli\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\visioncli\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ; The stable path Claude Code runs the MCP server through (the app refreshes it on start too).
  CreateDirectory "$LOCALAPPDATA\visioncli\bin"
  CopyFiles /SILENT "$INSTDIR\resources\win\visioncli-mcp.cmd" "$LOCALAPPDATA\visioncli\bin"
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first: keep what the new install writes again anyway, and the user's settings
  ; (%APPDATA%\visioncli) always.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\visioncli"
    Delete "$LOCALAPPDATA\visioncli\bin\visioncli-mcp.cmd"
    RMDir "$LOCALAPPDATA\visioncli\bin"
  ${endIf}
!macroend
