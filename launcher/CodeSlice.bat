@echo off
title CodeSlice
rem 已经在运行就直接打开页面
curl -s -o nul -m 2 http://localhost:5273/ >nul 2>&1
if %errorlevel%==0 (
    start "" http://localhost:5273
    exit /b 0
)
rem 在 WSL 里启动服务（最小化窗口，关闭它即停止应用）
start "CodeSlice server" /min wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /mnt/e/vibecoding/CodeSlice && npm run dev"
rem 等服务就绪再开浏览器（最多 40 秒）
for /l %%i in (1,1,40) do (
    timeout /t 1 /nobreak >nul
    curl -s -o nul -m 1 http://localhost:5273/ && goto :ready
)
:ready
start "" http://localhost:5273
