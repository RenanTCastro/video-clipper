import path from 'node:path';
import fs from 'node:fs';
import { run } from './utils.js';

// Argumentos extras do yt-dlp (ex.: YTDLP_ARGS="--cookies-from-browser chrome" para vídeos do YouTube que pedem login)
const extra = () => (process.env.YTDLP_ARGS || '').split(/\s+/).filter(Boolean);

/** Metadados do VOD (título, duração, canal). */
export async function getVodInfo(url) {
  const json = await run('yt-dlp', [...extra(), '-J', '--no-warnings', url]);
  const info = JSON.parse(json);
  if (info.is_live) throw new Error('Esta transmissão ainda está ao vivo. Aguarde terminar (ou use o VOD/gravação depois).');
  if (!info.duration) throw new Error('Não consegui ler a duração do vídeo.');
  return {
    id: info.id,
    title: info.title,
    channel: info.uploader || info.channel || 'twitch',
    duration: info.duration,
  };
}

/**
 * Baixa só o áudio do VOD (bem mais leve que o vídeo) e converte
 * para mono 16kHz, que é o que o Whisper usa.
 */
export async function downloadAudio(url, workDir) {
  const out = path.join(workDir, 'audio.m4a');
  if (fs.existsSync(out)) return out;
  await run(
    'yt-dlp',
    [...extra(), '-f', 'bestaudio/audio_only/worst', '-x', '--audio-format', 'm4a', '-o', path.join(workDir, 'audio.%(ext)s'), url],
    { verbose: true }
  );
  return out;
}

/**
 * Baixa somente o trecho do vídeo necessário para um corte,
 * em vez do VOD inteiro (que pode ter 10h+).
 */
export async function downloadSection(url, start, end, outFile, quality = 1080) {
  if (fs.existsSync(outFile)) return outFile;
  await run(
    'yt-dlp',
    [
      ...extra(),
      // YouTube separa vídeo e áudio (junta com ffmpeg); Twitch já vem junto e cai no "b"
      '-f', `bv*[height<=${quality}]+ba/b[height<=${quality}]/b`,
      '--merge-output-format', 'mp4',
      '--download-sections', `*${start.toFixed(2)}-${end.toFixed(2)}`,
      '--force-keyframes-at-cuts',
      '-o', outFile,
      url,
    ],
    { verbose: false }
  );
  return outFile;
}
