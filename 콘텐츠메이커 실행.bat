@echo off
setlocal EnableExtensions

cd /d "%~dp0"

title Content Maker

echo.
echo ==========================================
echo          CONTENT MAKER
echo ==========================================
echo.
echo Folder:
echo %CD%
echo.

if not exist "server.js" (
    echo ERROR: server.js not found.
    echo.
    pause
    exit /b 1
)

if not exist "package.json" (
    echo ERROR: package.json not found.
    echo.
    pause
    exit /b 1
)

where node.exe >nul 2>&1

if errorlevel 1 (
    echo ERROR: Node.js is not installed.
    echo.
    pause
    exit /b 1
)

echo Checking server...
echo.

curl.exe -s --max-time 2 http://127.0.0.1:3000/api/health >nul 2>&1

if not errorlevel 1 (
    echo Server is already running.
    echo.
    start "" "http://127.0.0.1:3000/content_maker.html"
    timeout /t 2 /nobreak >nul
    exit /b 0
)

if not exist "node_modules" (
    echo Installing packages...
    echo.

    call npm install

    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo Starting server...
echo.

start "Content Maker Server" /min cmd /c "cd /d ""%CD%"" && node server.js"

echo Waiting for server...

set READY=0

for /L %%N in (1,1,30) do (

    curl.exe -s --max-time 2 http://127.0.0.1:3000/api/health >nul 2>&1

    if not errorlevel 1 (
        set READY=1
        goto SERVER_READY
    )

    timeout /t 1 /nobreak >nul

)

:SERVER_READY

if "%READY%"=="1" (

    echo.
    echo ==========================================
    echo          SERVER READY
    echo ==========================================
    echo.
    echo http://127.0.0.1:3000/content_maker.html
    echo.

    start "" "http://127.0.0.1:3000/content_maker.html"

    timeout /t 2 /nobreak >nul

    exit /b 0
)

echo.
echo ==========================================
echo SERVER START FAILED
echo ==========================================
echo.
echo Please run this command manually:
echo.
echo node server.js
echo.
pause

exit /b 1