@echo off
title HnStore IP Changer
echo ==========================================
echo       HnStore IP/Domain Changer
echo ==========================================
echo.
echo Current configuration might be using 'localhost:3000'
echo.
set /p NEW_IP="Enter New IP or Domain (e.g., 1.2.3.4:3000): "

if "%NEW_IP%"=="" (
    echo Error: IP cannot be empty.
    pause
    exit /b
)

echo.
echo Processing files... Please wait...
echo ------------------------------------------

:: Using PowerShell to perform the replacement excluding node_modules and system files
powershell -Command "Get-ChildItem -Recurse -File -Exclude 'node_modules','*lock.json','.git','*.bat','*.png','*.jpg','*.jar' | ForEach-Object { $content = Get-Content $_.FullName -Raw; if ($content -match 'localhost:3000') { echo ('Updating: ' + $_.FullName); $content = $content -replace 'localhost:3000', '%NEW_IP%'; Set-Content $_.FullName $content -NoNewline } }"

:: Also update global config if it exists
if exist "data\config.json" (
    powershell -Command "$cfg = Get-Content 'data\config.json' | ConvertFrom-Json; if ($cfg.serverAddress) { $cfg.serverAddress = '%NEW_IP%'; $cfg | ConvertTo-Json | Set-Content 'data\config.json' }"
)

echo ------------------------------------------
echo ✅ Done! All occurrences of 'localhost:3000' have been updated to '%NEW_IP%'.
echo Please restart your server for changes to take effect.
echo.
pause
