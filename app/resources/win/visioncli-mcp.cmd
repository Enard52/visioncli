@echo off
rem visioncli-mcp: VisionCLI's MCP server, run by the app's own exe in Node mode (ELECTRON_RUN_AS_NODE=1), so no
rem separate Node install is needed (the Windows counterpart of resources/bin/visioncli-mcp). The installer and the
rem app copy it to %LOCALAPPDATA%\visioncli\bin, a path that survives updates, and it's registered once with
rem   claude mcp add visioncli --scope user -- cmd /c "%LOCALAPPDATA%\visioncli\bin\visioncli-mcp.cmd"
rem Any arguments go to the server's CLI, e.g. `visioncli-mcp install` or `visioncli-mcp quick "open github"`.
rem Which app: %VISIONCLI_APP%, else the per-user install (%LOCALAPPDATA%\Programs\VisionCLI\VisionCLI.exe).
setlocal
set "VCLI_EXE=%VISIONCLI_APP%"
if not defined VCLI_EXE set "VCLI_EXE=%LOCALAPPDATA%\Programs\VisionCLI\VisionCLI.exe"
if not exist "%VCLI_EXE%" goto missing
for %%I in ("%VCLI_EXE%") do set "VCLI_RES=%%~dpIresources"
rem The bootstrap removes ELECTRON_RUN_AS_NODE again, so programs the server starts (the app itself, VS Code) run normally.
set ELECTRON_RUN_AS_NODE=1
"%VCLI_EXE%" "%VCLI_RES%\win\visioncli-mcp.cjs" %*
exit /b %ERRORLEVEL%

:missing
echo visioncli-mcp: VisionCLI isn't installed at "%VCLI_EXE%". Get the installer from https://github.com/thethirdsourcers/visioncli/releases 1>&2
exit /b 1
