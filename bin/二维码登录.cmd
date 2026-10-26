@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node.exe —— 这个程序要用 DSH 自带的 Node。
  echo 在 DSH 里让 AI 跑：node "%~dp0qr.mjs"
  pause
  exit /b 1
)
node "%~dp0qr.mjs" %*
if errorlevel 1 (
  echo.
  echo 没有登录成功，窗口先别关可以看看上面的提示。
  pause
)
endlocal
