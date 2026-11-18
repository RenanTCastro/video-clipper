@echo off
REM Sobe o servidor de transcrição local (whisper.cpp) na porta 8178 (Windows).
cd /d "%~dp0"
set WHISPER_EXE=whisper-server
if exist "whisper-cpp\whisper-server.exe" set WHISPER_EXE=whisper-cpp\whisper-server.exe
"%WHISPER_EXE%" -m models\ggml-large-v3-turbo.bin --port 8178 --inference-path /v1/audio/transcriptions -l pt -t 4
if errorlevel 1 (
  echo.
  echo Falhou. Rode primeiro: powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1
  pause
)
