#!/bin/zsh
# Sobe o servidor de transcrição local (whisper.cpp) na porta 8178.
cd "$(dirname "$0")"
exec whisper-server -m models/ggml-large-v3-turbo.bin --port 8178 \
  --inference-path /v1/audio/transcriptions -l pt -t 4
