@echo off
rem Formcraft: build the ArchiCAD 28 objects (.gsm) from the GDL XML sources in .\src
rem Writes .\gsm\*.gsm, a log in .\build_log.txt and a round-trip check in .\roundtrip\
setlocal enabledelayedexpansion
cd /d "%~dp0"
set CONV=
for %%P in ("C:\Program Files\Graphisoft\Archicad 28" "C:\Program Files\GRAPHISOFT\ARCHICAD 28" "C:\Program Files\Graphisoft\Archicad 28 INT" "D:\Program Files\Graphisoft\Archicad 28") do (
  if exist "%%~P\LP_XMLConverter.exe" set CONV=%%~P\LP_XMLConverter.exe
)
if "%CONV%"=="" for /f "delims=" %%F in ('dir /s /b "C:\Program Files\Graphisoft\LP_XMLConverter.exe" 2^>nul') do set CONV=%%F
echo Formcraft GDL build %date% %time% > build_log.txt
echo Converter: %CONV% >> build_log.txt
if "%CONV%"=="" (echo LP_XMLConverter.exe not found >> build_log.txt & goto :end)
if not exist gsm mkdir gsm
if not exist roundtrip mkdir roundtrip
for %%f in (src\*.xml) do (
  echo. >> build_log.txt
  echo === %%~nf >> build_log.txt
  "%CONV%" xml2libpart "%%f" "gsm\%%~nf.gsm" >> build_log.txt 2>&1
  echo exit !errorlevel! >> build_log.txt
  if exist "gsm\%%~nf.gsm" "%CONV%" libpart2xml "gsm\%%~nf.gsm" "roundtrip\%%~nf.xml" >> build_log.txt 2>&1
)
:end
echo done >> build_log.txt
