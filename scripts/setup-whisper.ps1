# Baixa o whisper.cpp (servidor) e o modelo large-v3-turbo para transcrição local no Windows.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path 'whisper-cpp\whisper-server.exe')) {
  Write-Host 'Baixando whisper.cpp (binário para Windows)...'
  $zip = Join-Path $env:TEMP 'whisper-bin-x64.zip'
  Invoke-WebRequest 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip' -OutFile $zip
  Expand-Archive $zip -DestinationPath 'whisper-cpp-tmp' -Force
  $exe = Get-ChildItem 'whisper-cpp-tmp' -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
  if (-not $exe) { throw 'whisper-server.exe não veio no zip. Baixe manualmente em https://github.com/ggml-org/whisper.cpp/releases e extraia em whisper-cpp\' }
  if (Test-Path 'whisper-cpp') { Remove-Item 'whisper-cpp' -Recurse -Force }
  Move-Item $exe.DirectoryName 'whisper-cpp'
  Remove-Item 'whisper-cpp-tmp' -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force models | Out-Null
if (-not (Test-Path 'models\ggml-large-v3-turbo.bin')) {
  Write-Host 'Baixando o modelo (~1,6 GB)...'
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin' -OutFile 'models\ggml-large-v3-turbo.bin'
}
Write-Host 'Pronto! Agora rode start-whisper.bat (deixe a janela aberta).'
