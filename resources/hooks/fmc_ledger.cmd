@echo off
rem Formcraft ledger hook for a batch file. docs/AUTOMATION_BALANCE.md
rem Records one run in %APPDATA%\Formcraft\ledger\external-YYYY-MM.jsonl: kind, script, ok (the exit code), no names.
rem Paste this one line at the end of the batch file (fmc_ledger.ps1 beside it; it never changes the exit code):
rem
rem   powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fmc_ledger.ps1" -Kind batch -Script "%~n0" -Ok %ERRORLEVEL% & exit /b %ERRORLEVEL%
rem
rem (both %ERRORLEVEL% are read when the line is parsed, so the exit code is the script's own, not PowerShell's)
rem
rem Or call this file: fmc_ledger.cmd <script name> <exit code>
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fmc_ledger.ps1" -Kind batch -Script "%~1" -Ok "%~2"
exit /b 0
