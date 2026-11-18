# Instala as dependências no Windows 10/11 via winget: Node.js, yt-dlp e ffmpeg (build "full", com legendas).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1   (depois feche e reabra o terminal)
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
winget install --id yt-dlp.yt-dlp -e
winget install --id Gyan.FFmpeg -e
Write-Host 'Feche e abra o terminal de novo, depois rode: npm install'
