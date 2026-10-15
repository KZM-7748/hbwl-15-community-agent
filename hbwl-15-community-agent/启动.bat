@echo off
title 15栋一站式社区智能体
cd /d "%~dp0"

echo ============================================================
echo   湖北文理学院 . 计算机工程学院
echo   15栋一站式社区智能体
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo.
  echo 请先安装 Node.js 18 或更高版本：https://nodejs.org
  echo 安装完成后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo 正在启动服务，稍后会自动打开浏览器...
echo.
echo   ^>^> 请勿关闭本窗口，关闭窗口即停止服务 ^<^<
echo.

rem 延迟 3 秒后打开浏览器（此时服务应已就绪）
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:8080"

rem 前台运行服务：窗口关闭 = 服务停止
node server.js

echo.
echo 服务已停止。
pause