@echo off
echo ===================================================
echo       IPAM System - Build and Start Server
echo ===================================================
echo.

echo [Step 1/3] Installing dependencies (npm install)...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install dependencies. Please check npm logs.
    pause
    exit /b %errorlevel%
)
echo [OK] Dependencies installed successfully.
echo.

echo [Step 2/3] Building the Frontend (npm run build)...
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to build the frontend. Please check for syntax errors.
    pause
    exit /b %errorlevel%
)
echo [OK] Frontend built successfully!
echo.

echo ===================================================
echo [Step 3/3] Starting Server...
echo Starting server on port 3000 in Production mode...
echo ===================================================
set "NODE_ENV=production"
call npx tsx server.ts --prod

pause