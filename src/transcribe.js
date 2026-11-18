import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { Agent, setGlobalDispatcher } from 'undici';

// Whisper local pode levar vários minutos por pedaço: tira o limite de espera (padrão do Node: 5 min)
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));
import { run, log, fmtTime, checkCancel } from './utils.js';

const CHUNK_SECONDS = 600; // 10 min por pedaço → ~5MB em mp3 32kbps (limite da API é 25MB)

/**
 * Transcreve o áudio inteiro com timestamps por palavra.
 * Divide em pedaços, transcreve em paralelo (limitado) e junta tudo.
 * Resultado fica em cache em transcript.json.
 */
export async function transcribe(audioFile, workDir, { duration, language, concurrency = Number(process.env.TRANSCRIBE_CONCURRENCY) || 4 }) {
  const cache = path.join(workDir, 'transcript.json');
  if (fs.existsSync(cache)) {
    log('Usando transcrição em cache');
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }

  const client = new OpenAI({
    apiKey: process.env.TRANSCRIBE_API_KEY,
    baseURL: process.env.TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1',
    timeout: 60 * 60 * 1000,
    maxRetries: 0, // as tentativas são feitas por withRetry (abaixo)
  });
  const model = process.env.TRANSCRIBE_MODEL || 'whisper-1';

  const chunkDir = path.join(workDir, 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  const starts = [];
  for (let s = 0; s < duration; s += CHUNK_SECONDS) starts.push(s);

  const results = new Array(starts.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < starts.length) {
      checkCancel();
      const i = next++;
      const start = starts[i];
      const file = path.join(chunkDir, `chunk_${String(i).padStart(4, '0')}.mp3`);
      if (!fs.existsSync(file)) {
        // grava num arquivo temporário: se for cancelado no meio, não sobra pedaço corrompido no cache
        const tmp = file.replace(/\.mp3$/, '.part.mp3');
        await run('ffmpeg', [
          '-y', '-ss', String(start), '-t', String(CHUNK_SECONDS), '-i', audioFile,
          '-ac', '1', '-ar', '16000', '-b:a', '32k', tmp,
        ]);
        fs.renameSync(tmp, file);
      }
      const res = await withRetry(() =>
        client.audio.transcriptions.create({
          file: fs.createReadStream(file),
          model,
          language,
          response_format: 'verbose_json',
          timestamp_granularities: ['word', 'segment'],
        })
      );
      results[i] = {
        segments: (res.segments || []).map((s) => ({
          start: s.start + start,
          end: s.end + start,
          text: s.text.trim(),
        })),
        words: (res.words?.length ? res.words : mergeTokens(res.segments))
          .map((w) => ({
            start: w.start + start,
            end: w.end + start,
            word: w.word.trim(),
          })),
      };
      done++;
      log(`Transcrito ${done}/${starts.length} (${fmtTime(start)})`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));

  const transcript = {
    segments: results.flatMap((r) => r.segments),
    words: results.flatMap((r) => r.words),
  };
  fs.writeFileSync(cache, JSON.stringify(transcript));
  return transcript;
}

/**
 * O whisper.cpp local devolve as palavras dentro de cada segmento e quebradas em tokens
 * (" cl" + "ipe"). Um token com espaço na frente começa uma palavra nova; os outros
 * (sílabas, pontuação) são colados na palavra anterior.
 */
function mergeTokens(segments = []) {
  const words = [];
  for (const seg of segments) {
    for (const t of seg.words || []) {
      const last = words[words.length - 1];
      if (last && !/^\s/.test(t.word)) {
        last.word += t.word;
        last.end = t.end;
      } else if (t.word.trim()) {
        words.push({ word: t.word, start: t.start, end: t.end });
      }
    }
  }
  return words;
}

async function withRetry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      const wait = 2000 * 2 ** i;
      log(`Erro na transcrição (${e.status || e.message}), tentando de novo em ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
