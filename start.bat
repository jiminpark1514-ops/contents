@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Content Maker

echo.
echo ==========================================
echo          CONTENT MAKER
echo ==========================================
echo.

echo [1/4] Checking Node.js...
where node.exe >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Node.js is not installed.
    echo Node.js LTS를 설치한 뒤 다시 실행하세요.
    echo.
    pause
    exit /b 1
)

if not exist "server.js" (
    echo ERROR: server.js not found.
    pause
    exit /b 1
)

if not exist "package.json" (
    echo ERROR: package.json not found.
    pause
    exit /b 1
)

echo [2/4] Checking server...
curl.exe -s --max-time 2 http://127.0.0.1:3000/api/health >nul 2>&1
if not errorlevel 1 (
    echo Server is already running.
    echo [4/4] Opening Content Maker...
    start "" "http://127.0.0.1:3000/content_maker.html"
    exit /b 0
)

if not exist "node_modules" (
    echo.
    echo Installing required packages...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
)

echo [3/4] Starting server...
if exist "server-error.log" del /q "server-error.log" >nul 2>&1

start "Content Maker Server" /min cmd /c "cd /d ""%~dp0"" && node server.js > ""%~dp0server-error.log"" 2>&1"

echo Waiting for server...
set "READY=0"

for /L %%N in (1,1,20) do (
    curl.exe -s --max-time 2 http://127.0.0.1:3000/api/health >nul 2>&1
    if not errorlevel 1 (
        set "READY=1"
        goto SERVER_READY
    )
    timeout /t 1 /nobreak >nul
)

:SERVER_READY
if "%READY%"=="0" (
    echo.
    echo ==========================================
    echo ERROR: 서버가 시작되지 않았습니다.
    echo ==========================================
    echo.
    if exist "server-error.log" (
        echo ----- server-error.log -----
        type "server-error.log"
        echo ----------------------------
    ) else (
        echo server-error.log 파일이 생성되지 않았습니다.
    )
    echo.
    echo 위 오류 내용을 확인하세요.
    pause
    exit /b 1
)

echo.
echo Server started successfully!
echo [4/4] Opening Content Maker...
echo http://127.0.0.1:3000/content_maker.html
echo.
start "" "http://127.0.0.1:3000/content_maker.html"

timeout /t 2 /nobreak >nul
exit /b 0
