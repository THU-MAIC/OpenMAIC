@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo.
  echo   依赖还没装。先在仓库根目录跑一次：
  echo       pnpm install
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动长课修订实验控制台...
echo   浏览器会自动打开；没打开就手动访问 http://localhost:8787
echo.

if exist "node_modules\.bin\tsx.cmd" (
  call "node_modules\.bin\tsx.cmd" --conditions=import scripts/long-form/experiment-server.ts
) else (
  call npx --yes tsx --conditions=import scripts/long-form/experiment-server.ts
)

echo.
echo   服务已停止。
pause
