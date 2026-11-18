# Twitch Clipper — cortes com IA a partir de VODs da Twitch e vídeos do YouTube

Cole o link de um VOD e receba cortes verticais (9:16) prontos para TikTok, Reels e Shorts, com legenda animada e gancho no topo — no estilo do Opus Clip.

## Como funciona

1. **Baixa só o áudio** do VOD com `yt-dlp` (leve, mesmo em lives de 10h)
2. **Transcreve** com Whisper (local, Groq ou OpenAI), com tempo de cada palavra
3. **Claude analisa** a transcrição em janelas de 25 min e dá nota de potencial viral pra cada momento
4. Escolhe os melhores, remove duplicados e ajusta início/fim para não cortar frases no meio. O corte começa alguns segundos **antes** do momento que a IA marcou (pré-roll, padrão 25s) para a jogada aparecer, e não só a reação a ela
5. **Baixa só os trechos** escolhidos em vídeo
6. **Renderiza** em 1080x1920 com legenda palavra-por-palavra e o gancho no topo

Funciona com links `twitch.tv/videos/...` e do YouTube (`youtube.com/watch?v=...`, `youtu.be/...`, `/live/...`, `/shorts/...`). Transmissões ainda ao vivo não são aceitas: use depois que terminarem. Se o YouTube pedir login ("confirme que você não é um robô"), defina no `.env` algo como `YTDLP_ARGS=--cookies-from-browser chrome`.

## Rodar localmente (passo a passo)

Funciona em **Mac** e **Windows 10/11**. Precisa de Node.js 18+, `yt-dlp` e `ffmpeg` com suporte a legendas (libass).

### 1. Instalar as dependências

**Mac** (Homebrew):

```bash
brew install node yt-dlp
brew install ffmpeg-full      # precisa ter suporte a legendas (libass)
```

Se já tinha o `ffmpeg` comum: `brew uninstall ffmpeg && brew install ffmpeg-full` (e, se necessário, `brew link --overwrite ffmpeg-full`).

**Windows** (PowerShell, usa o winget que já vem no Windows):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
```

Isso instala Node.js, yt-dlp e ffmpeg (build "full" do gyan.dev, com legendas). **Feche e abra o terminal** depois.

### 2. Instalar o projeto e configurar as chaves

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
```

Abra o `.env` e preencha:

- `ANTHROPIC_API_KEY`: chave do Claude (escolhe os melhores momentos)
- `TRANSCRIBE_PROVIDER`: **como transcrever o áudio** (escolha um):

| Opção | Custo | Quando usar |
|---|---|---|
| `local` | grátis | PC razoável (GPU ajuda); lento em lives longas. Siga o passo 3 |
| `groq` ⭐ | ~US$ 0,04 por hora de áudio | **Indicado** para substituir o local: muito rápido e barato. Crie a chave em https://console.groq.com/keys e ponha em `GROQ_API_KEY` |
| `openai` | ~US$ 0,36 por hora de áudio | Se já tem conta na OpenAI. Chave em https://platform.openai.com/api-keys, em `OPENAI_API_KEY` |

Para trocar de uma opção para outra, basta mudar `TRANSCRIBE_PROVIDER` (e preencher a chave, se for nuvem). Nas opções de nuvem, pule o passo 3.

### 3. (Só para `TRANSCRIBE_PROVIDER=local`) instalar o Whisper local

**Mac:**

```bash
brew install whisper-cpp
./scripts/setup-whisper.sh    # baixa o modelo (~1,6 GB) em models/
./start-whisper.sh            # em um terminal separado, deixe aberto
```

**Windows:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1   # baixa whisper.cpp + modelo (~1,6 GB)
start-whisper.bat                                                     # deixe esta janela aberta
```

Se o download automático do whisper.cpp falhar no Windows, baixe o `whisper-bin-x64.zip` em https://github.com/ggml-org/whisper.cpp/releases e extraia na pasta `whisper-cpp\` do projeto. Para usar GPU NVIDIA, baixe a versão `whisper-cublas-*-bin-x64.zip`.

### 4. Abrir a interface

```bash
npm run web
```

Acesse **http://localhost:3000**. Para encerrar, `Ctrl+C` em cada terminal.

Opcional: crie uma pasta `fonts/` com `Montserrat-Black.ttf` (Google Fonts) para a legenda ficar no estilo viral. Sem ela, o ffmpeg usa uma fonte padrão.

### Problemas comuns

- **`Connection error` / `ECONNREFUSED` na transcrição**: o Whisper local não está rodando (`./start-whisper.sh` no Mac, `start-whisper.bat` no Windows) — ou troque `TRANSCRIBE_PROVIDER` para `groq`.
- **"Seu ffmpeg não tem suporte a legendas"**: instale o `ffmpeg-full` (passo 1).
- **`Já existe um trabalho em andamento`**: só roda um processo por vez; use o botão **Cancelar** ou espere terminar.
- **Porta 3000 ocupada**: `PORT=3100 npm run web` (Windows PowerShell: `$env:PORT=3100; npm run web`).
- **YouTube pede login**: ponha `YTDLP_ARGS=--cookies-from-browser chrome` no `.env`.

## Uso pela linha de comando (opcional)

```bash
# 10 cortes de 20–60s com fundo desfocado
node src/index.js https://www.twitch.tv/videos/1234567890

# começar 30s antes do momento escolhido pela IA (padrão 25; 0 desliga)
node src/index.js https://www.twitch.tv/videos/1234567890 --pre 30

# 5 cortes, ver primeiro os momentos sem renderizar
node src/index.js https://www.twitch.tv/videos/1234567890 -n 5 --dry-run

# Layout facecam em cima + gameplay embaixo
# --cam = x,y,largura,altura da câmera em % da tela (aqui: canto superior esquerdo)
node src/index.js https://www.twitch.tv/videos/1234567890 --layout split --cam 0,0,25,30

# Live IRL/só câmera: corta o centro e preenche a tela
node src/index.js https://www.twitch.tv/videos/1234567890 --layout crop
```

**Gancho e teaser:** a IA escreve o título como gancho de curiosidade (3–6 palavras, sem spoiler), que aparece grande no topo do vídeo no template. Ela também marca o **ápice** de cada corte (`peak`): os ~3s mais fortes entram no começo do vídeo como teaser, antes da jogada completa. Dá para desligar na interface ("Abertura com teaser") ou com `--no-teaser`, e ajustar o ápice de cada corte na revisão.

Os cortes saem em `output/<canal>_<id>/`, junto com `cortes.json` (título, nota, motivo e link com o timestamp no VOD para cada corte).

O pré-roll soma ao tamanho do corte (ex.: máx. 60s + 25s de pré-roll = até ~85s). Se quiser cortes de até 60s no total, use `--max 35`.

Transcrição e análise ficam em cache em `.cache/`, então rodar de novo com outro layout ou quantidade é rápido e não gasta API de novo.

## Template (arte de fundo)

O layout **template** (padrão na interface web) coloca o corte dentro da moldura de uma arte, com o título do corte no topo e a legenda na área de baixo. Os templates ficam em `templates/<nome>/` (`overlay.png` 1080x1920 com o furo do vídeo **transparente** + `template.json` com posição do vídeo, título e legenda). Já vêm `gta6` e `arc-raiders`.

Para criar outro a partir de uma arte (ela apaga os textos de exemplo e mede o furo sozinha):

```bash
python3 tools/make_template.py minha-arte.webp meu-template "Nome do Template"
```

Na linha de comando: `--layout template`.

## Interface web (com etapa de revisão)

```bash
npm run web   # abre em http://localhost:3000
```

1. Cole o link do vídeo (Twitch ou YouTube) e clique em **Analisar** (baixa o áudio, transcreve e a IA escolhe os momentos)
2. **Revisar textos**: para cada corte, edite o gancho do topo e as legendas, ouça o trecho, ajuste início/fim e desmarque os cortes que não quiser
3. Escolha o layout/template e clique em **Renderizar**. Os vídeos aparecem na própria tela e ficam em `output/`

As edições são salvas sozinhas em `.cache/<id>/job.json`.

## Custos aproximados (live de 4h)

- Transcrição: grátis no modo local; ~US$ 0,16 no Groq ou ~US$ 1,40 na OpenAI
- Análise com Claude Sonnet: alguns centavos a ~US$ 1, dependendo do tamanho da live

## Ideias para evoluir

- Usar os picos de mensagens do chat da Twitch como sinal extra de momento bom
- Detectar a facecam automaticamente (face detection) em vez de passar `--cam`
- Postagem automática nas redes
