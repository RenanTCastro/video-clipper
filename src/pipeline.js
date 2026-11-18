import fs from 'node:fs';
import path from 'node:path';
import { log, fmtTime, slug, checkCancel } from './utils.js';
import { getVodInfo, downloadAudio, downloadSection } from './download.js';
import { transcribe } from './transcribe.js';
import { findHighlights } from './highlights.js';
import { buildAss } from './subtitles.js';
import { renderVertical, loadTemplate } from './render.js';

export const CACHE_DIR = path.resolve('.cache');
export const OUT_DIR = path.resolve('output');
const TEASER_LEN = 3; // duração do teaser do ápice, em segundos
const TEASER_BEFORE = 1.2; // o teaser começa um pouco antes do ápice
const PAD = 15; // segundos de contexto antes/depois do corte, para ajustar início/fim na revisão

/**
 * Extrai o id do vídeo do link (mesmo id que o yt-dlp devolve):
 * Twitch -> "v123..."; YouTube -> os 11 caracteres do vídeo. Devolve null se não reconhecer.
 */
export const vodIdFromUrl = (url) => {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host.endsWith('twitch.tv')) {
    const m = u.pathname.match(/\/(?:videos|video|v)\/(\d+)/);
    return m ? `v${m[1]}` : null;
  }
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host.endsWith('youtube.com')) {
    id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:live|shorts|embed|v)\/([\w-]{11})/) || [])[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
};

/** Link do vídeo no segundo exato (Twitch e YouTube aceitam ?t=123s). */
export function linkAt(url, seconds) {
  try {
    const u = new URL(url);
    u.searchParams.set('t', `${Math.floor(seconds)}s`);
    return u.toString();
  } catch {
    return url;
  }
}

const jobFile = (id) => path.join(CACHE_DIR, String(id), 'job.json');

export function loadJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export function saveJob(job) {
  fs.mkdirSync(path.dirname(jobFile(job.id)), { recursive: true });
  fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
}

export function listJobs() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs
    .readdirSync(CACHE_DIR)
    .map((id) => loadJob(id))
    .filter(Boolean)
    .map((j) => ({
      id: j.id,
      url: j.url,
      title: j.info.title,
      channel: j.info.channel,
      clips: j.clips.length,
      rendered: j.clips.filter((c) => c.file).length,
      updatedAt: j.updatedAt,
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/**
 * Monta as "linhas" de legenda de um corte: uma por segmento do Whisper, cada uma com suas palavras
 * e tempos. Inclui PAD segundos de contexto em volta para dar para ajustar início/fim.
 */
export function buildLines(transcript, start, end) {
  const from = start - PAD;
  const to = end + PAD;
  const segs = transcript.segments.filter((s) => s.end > from && s.start < to && s.text);
  const lines = segs.map((s) => ({ start: s.start, end: s.end, words: [] }));
  if (!lines.length) return [];

  for (const w of transcript.words) {
    if (w.end <= from || w.start >= to || !w.word) continue;
    const mid = (w.start + w.end) / 2;
    let best = 0;
    let bestDist = Infinity;
    lines.forEach((l, i) => {
      const d = mid < l.start ? l.start - mid : mid > l.end ? mid - l.end : 0;
      if (d < bestDist) { bestDist = d; best = i; }
    });
    lines[best].words.push({ start: w.start, end: w.end, word: w.word });
  }
  return lines
    .filter((l) => l.words.length)
    .map((l) => ({ ...l, text: l.words.map((w) => w.word).join(' ') }));
}

/** Se o texto da linha mudou, redistribui os tempos das palavras no mesmo intervalo da linha. */
function applyLineEdit(line) {
  const old = line.words || [];
  const joined = old.map((w) => w.word).join(' ');
  const text = String(line.text ?? joined).trim();
  if (text === joined) return { ...line, text, words: old };

  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ...line, text: '', words: [] };

  if (tokens.length === old.length) {
    return { ...line, text, words: old.map((w, i) => ({ ...w, word: tokens[i] })) };
  }
  const t0 = old.length ? old[0].start : line.start;
  const t1 = old.length ? old[old.length - 1].end : line.end;
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  const words = tokens.map((t, i) => {
    const s = t0 + ((t1 - t0) * acc) / total;
    acc += weights[i];
    return { word: t, start: s, end: t0 + ((t1 - t0) * acc) / total };
  });
  return { ...line, text, words };
}

/** Aceita os cortes editados na tela e devolve a versão normalizada para salvar. */
export function mergeEdits(job, editedClips) {
  const byId = new Map(job.clips.map((c) => [c.id, c]));
  const clips = [];
  for (const e of editedClips) {
    const base = byId.get(e.id);
    if (!base) continue;
    const start = Number(e.start);
    const end = Number(e.end);
    clips.push({
      ...base,
      title: String(e.title ?? base.title).trim() || base.title,
      hook: String(e.hook ?? '').trim(),
      peak: 'peak' in e ? (e.peak === null || e.peak === '' || !Number.isFinite(Number(e.peak)) ? null : Number(e.peak)) : base.peak ?? null,
      enabled: e.enabled !== false,
      start: Number.isFinite(start) ? Math.max(0, start) : base.start,
      end: Number.isFinite(end) && end > start ? Math.min(end, job.info.duration) : base.end,
      lines: Array.isArray(e.lines) ? e.lines.map(applyLineEdit) : base.lines,
    });
  }
  return clips;
}

/** Baixa áudio, transcreve e pede para a IA escolher os momentos. Para na revisão. */
export async function analyzeVod(url, { count = 10, min = 20, max = 60, preRoll = Number(process.env.PRE_ROLL ?? 25), lang = 'pt' } = {}) {
  log('Lendo informações do vídeo...');
  const info = await getVodInfo(url);
  log(`"${info.title}" — ${info.channel} — ${fmtTime(info.duration)}`);

  const workDir = path.join(CACHE_DIR, String(info.id));
  fs.mkdirSync(workDir, { recursive: true });

  log('Baixando áudio...');
  const audio = await downloadAudio(url, workDir);

  log('Transcrevendo (pode demorar em lives longas)...');
  const transcript = await transcribe(audio, workDir, { duration: info.duration, language: lang });
  log(`${transcript.words.length} palavras transcritas`);

  log('IA procurando os melhores momentos...');
  const picked = await findHighlights(transcript, workDir, {
    duration: info.duration,
    count: Number(count),
    minLen: Number(min),
    maxLen: Number(max),
    preRoll: Math.max(0, Number(preRoll) || 0),
    vodTitle: info.title,
  });

  const clips = picked.map((c, i) => ({
    ...c,
    id: `c${i + 1}`,
    enabled: true,
    lines: buildLines(transcript, c.start, c.end),
  }));

  const old = loadJob(info.id);
  const job = {
    id: String(info.id),
    url,
    info,
    opts: { count, min, max, preRoll: Math.max(0, Number(preRoll) || 0), lang, teaser: old?.opts?.teaser ?? true, layout: old?.opts?.layout || 'template', template: old?.opts?.template || 'gta6', cam: old?.opts?.cam || null, quality: old?.opts?.quality || 1080 },
    clips,
    updatedAt: new Date().toISOString(),
  };
  saveJob(job);
  log(`${clips.length} momentos encontrados. Pronto para revisar!`);
  return job;
}

/** Renderiza os cortes ativos usando os textos revisados. */
export async function renderJob(job, { onProgress = () => {} } = {}) {
  const { layout = 'blur', cam = null, quality = 1080 } = job.opts;
  if (layout === 'split' && (!cam || cam.length !== 4 || cam.some((n) => !Number.isFinite(n)))) {
    throw new Error('Layout split precisa da posição da facecam (x, y, largura, altura em %).');
  }

  const template = layout === 'template' ? loadTemplate(job.opts.template || 'gta6') : null;

  const workDir = path.join(CACHE_DIR, job.id);
  const outDir = path.join(OUT_DIR, `${slug(job.info.channel)}_${job.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  // Nunca apaga arquivos: renderizar de novo só sobrescreve os de mesmo nome.
  const manifestFile = path.join(outDir, 'cortes.json');
  for (const c of job.clips) delete c.file;

  const active = job.clips.filter((c) => c.enabled !== false);
  const manifest = [];
  for (const [i, c] of active.entries()) {
    checkCancel();
    const n = String(i + 1).padStart(2, '0');
    const name = `${n}_${slug(c.title)}`;
    onProgress({ done: i, total: active.length, current: c.title });
    log(`[${n}/${active.length}] ${c.title}`);

    const raw = path.join(workDir, `raw_${c.start.toFixed(1)}_${c.end.toFixed(1)}.mp4`);
    await downloadSection(job.url, c.start, c.end, raw, Number(quality));

    // teaser: ~3s do ápice no começo do vídeo (só se o ápice estiver dentro do corte e não colado no início)
    let tz = null;
    if (job.opts.teaser !== false && Number.isFinite(c.peak) && c.peak >= c.start + 6 && c.peak <= c.end - 1) {
      const from = Math.max(c.start, c.peak - TEASER_BEFORE);
      tz = { from, to: Math.min(c.end, from + TEASER_LEN) };
    }

    const assFile = path.join(workDir, `${name}.ass`);
    fs.writeFileSync(assFile, buildAss(c.lines.flatMap((l) => l.words), c.start, c.end, { hook: c.hook, title: c.title, tpl: template, teaser: tz }));

    const output = path.join(outDir, `${name}.mp4`);
    await renderVertical(raw, assFile, output, { layout, cam, template, teaser: tz && { from: tz.from - c.start, len: tz.to - tz.from } });
    c.file = path.basename(output);
    manifest.push({ file: c.file, start: c.start, end: c.end, title: c.title, hook: c.hook, reason: c.reason, score: c.score, timestamp: fmtTime(c.start), vodUrl: linkAt(job.url, c.start) });
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  onProgress({ done: active.length, total: active.length, current: '' });
  log(`Pronto! ${manifest.length} cortes em ${outDir}`);
  return outDir;
}
