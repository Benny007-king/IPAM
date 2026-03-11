@echo off
echo ===================================================
echo       IPAM System - Starting Server
echo ===================================================
echo.
echo Starting server on port 3000 in Production mode...
set NODE_ENV=production
call npx tsx server.ts
pause