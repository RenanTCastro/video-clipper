#!/bin/sh
# Mac/Linux: baixa o modelo large-v3-turbo (~1,6 GB). O servidor vem do Homebrew: brew install whisper-cpp
cd "$(dirname "$0")/.." || exit 1
mkdir -p models
[ -f models/ggml-large-v3-turbo.bin ] || curl -L -o models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
echo "Pronto! Agora rode ./start-whisper.sh em outro terminal."
