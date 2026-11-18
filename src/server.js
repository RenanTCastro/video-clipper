#!/usr/bin/env node
import { missingKeys } from './config.js';
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeps, setLogSink, cancelAll, resetCancel } from './utils.js';
import { analyzeVod, renderJob, loadJob, saveJob, listJobs, mergeEdits, vodIdFromUrl, CACHE_DIR, OUT_DIR } from './pipeline.js';
import { slug } from './utils.js';

const PORT = Number(process.env.PORT) || 3000;
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

// Só um trabalho pesado por vez (o log de progresso é global).
let active = null; // { id, kind: 'analyze'|'render', logs: [], error, progress }
let last = null; // resultado do último trabalho, para o front ler o erro/fim

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => {
      data += d;
      if (data.length > 20e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });

function serveFile(req, res, file, type) {
  let stat;
  try { stat = fs.statSync(file); } catch { return send(res, 404, { error: 'não encontrado' }); }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  }
}

function startTask(id, kind, fn) {
  const state = { id, kind, logs: [], error: null, progress: null, done: false, cancelled: false };
  resetCancel();
  active = state;
  last = state;
  setLogSink((m) => state.logs.push(m));
  fn(state)
    .catch((e) => { state.error = e.message; })
    .finally(() => { state.done = true; active = null; setLogSink(null); });
  return state;
}

const publicState = (id) => {
  const s = last && last.id === String(id) ? last : null;
  if (!s) return { status: 'idle', logs: [] };
  return {
    status: s.done ? (s.cancelled ? 'cancelled' : s.error ? 'error' : 'ready') : s.kind === 'analyze' ? 'analyzing' : 'rendering',
    kind: s.kind, logs: s.logs.slice(-60), error: s.error, progress: s.progress,
  };
};

const outDirOf = (job) => path.join(OUT_DIR, `${slug(job.info.channel)}_${job.id}`);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = (re) => p.match(re);

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(WEB_DIR, 'index.html')), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && p === '/api/status') {
    const missing = missingKeys();
    return send(res, 200, { missing, busy: active ? { id: active.id, kind: active.kind } : null });
  }

  if (req.method === 'POST' && p === '/api/cancel') {
    if (!active) return send(res, 200, { ok: true, idle: true });
    active.cancelled = true;
    active.logs.push('Cancelando...');
    cancelAll();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/templates') {
    const dir = path.join(WEB_DIR, '..', 'templates');
    const list = fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((id) => {
      try { return [{ id, name: JSON.parse(fs.readFileSync(path.join(dir, id, 'template.json'), 'utf8')).name || id }]; } catch { return []; }
    }) : [];
    return send(res, 200, list);
  }

  if (req.method === 'GET' && p === '/api/jobs') return send(res, 200, listJobs());

  if (req.method === 'POST' && p === '/api/jobs') {
    const body = await readBody(req);
    const id = vodIdFromUrl(body.url);
    if (!id) return send(res, 400, { error: 'Link inválido. Use um VOD da Twitch (twitch.tv/videos/123...) ou um vídeo do YouTube (youtube.com/watch?v=... ou youtu.be/...).' });
    if (active) return send(res, 409, { error: 'Já existe um trabalho em andamento. Aguarde terminar.' });
    const missing = missingKeys();
    if (missing.length) return send(res, 400, { error: `Falta ${missing.join(', ')} no arquivo .env` });
    startTask(id, 'analyze', async () => {
      await checkDeps();
      await analyzeVod(body.url.trim(), { count: body.count || 10, min: body.min || 20, max: body.max || 60, ...(body.preRoll !== undefined && body.preRoll !== '' ? { preRoll: Number(body.preRoll) } : {}), lang: process.env.LANGUAGE || 'pt' });
    });
    return send(res, 202, { id });
  }

  let r;
  if ((r = m(/^\/api\/jobs\/([\w-]+)$/)) && req.method === 'GET') {
    const job = loadJob(r[1]);
    return send(res, 200, { job, state: publicState(r[1]) });
  }

  if ((r = m(/^\/api\/jobs\/([\w-]+)$/)) && req.method === 'PUT') {
    const job = loadJob(r[1]);
    if (!job) return send(res, 404, { error: 'projeto não encontrado' });
    if (active?.id === job.id && active.kind === 'render') return send(res, 409, { error: 'Renderizando agora; aguarde.' });
    const body = await readBody(req);
    job.clips = mergeEdits(job, body.clips || []);
    applyOpts(job, body.opts);
    job.updatedAt = new Date().toISOString();
    saveJob(job);
    return send(res, 200, { ok: true, updatedAt: job.updatedAt });
  }

  if ((r = m(/^\/api\/jobs\/([\w-]+)\/render$/)) && req.method === 'POST') {
    const job = loadJob(r[1]);
    if (!job) return send(res, 404, { error: 'projeto não encontrado' });
    if (active) return send(res, 409, { error: 'Já existe um trabalho em andamento. Aguarde terminar.' });
    const body = await readBody(req);
    job.clips = mergeEdits(job, body.clips || job.clips);
    applyOpts(job, body.opts);
    if (!job.clips.some((c) => c.enabled !== false)) return send(res, 400, { error: 'Nenhum corte selecionado.' });
    saveJob(job);
    startTask(job.id, 'render', async (state) => {
      await checkDeps();
      try {
        await renderJob(job, { onProgress: (pg) => { state.progress = pg; } });
      } finally {
        job.updatedAt = new Date().toISOString();
        saveJob(job);
      }
    });
    return send(res, 202, { id: job.id });
  }

  if ((r = m(/^\/media\/audio\/([\w-]+)$/)) && req.method === 'GET') {
    return serveFile(req, res, path.join(CACHE_DIR, r[1], 'audio.m4a'), 'audio/mp4');
  }

  if ((r = m(/^\/media\/clip\/([\w-]+)\/([\w.-]+\.mp4)$/)) && req.method === 'GET') {
    const job = loadJob(r[1]);
    if (!job) return send(res, 404, { error: 'não encontrado' });
    return serveFile(req, res, path.join(outDirOf(job), r[2]), 'video/mp4');
  }

  send(res, 404, { error: 'não encontrado' });
}

function applyOpts(job, o = {}) {
  if (['template', 'blur', 'crop', 'split'].includes(o.layout)) job.opts.layout = o.layout;
  if (typeof o.template === 'string' && /^[\w-]+$/.test(o.template) && fs.existsSync(path.join(WEB_DIR, '..', 'templates', o.template, 'template.json'))) job.opts.template = o.template;
  if (typeof o.teaser === 'boolean') job.opts.teaser = o.teaser;
  if (Array.isArray(o.cam) && o.cam.length === 4) job.opts.cam = o.cam.map(Number);
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: e.message }));
  })
  .listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`\nTwitch Clipper rodando em  http://localhost:${PORT}\n`);
  });
