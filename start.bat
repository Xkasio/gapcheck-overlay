@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo 처음 실행: 필요한 파일을 설치합니다...
  call npm install
)
node_modules\electron\dist\electron.exe .
