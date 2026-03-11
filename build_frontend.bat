@echo off
echo ===================================================
echo       IPAM System - Frontend Build Script
echo ===================================================
echo.

echo [Step 1/2] Installing dependencies (npm install)...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install dependencies. Please check npm logs.
    pause
    exit /b %errorlevel%
)
echo [OK] Dependencies installed successfully.
echo.

echo [Step 2/2] Building the Frontend (npm run build)...
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
echo SUCCESS! The 'dist' folder is ready for production.
echo ===================================================
pause