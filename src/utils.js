import { spawn } from 'node:child_process';

// Cancelamento: mata os processos em andamento e faz as próximas etapas pararem.
const children = new Set();
let cancelled = false;
export const resetCancel = () => { cancelled = false; };
export const checkCancel = () => { if (cancelled) throw new Error('Cancelado pelo usuário'); };
export function cancelAll() {
  cancelled = true;
  for (const c of children) c.kill('SIGTERM');
}

/** Roda um comando externo e devolve stdout. Mostra stderr se `verbose`. */
export function run(cmd, args, { verbose = false, cwd } = {}) {
  checkCancel();
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    children.add(p);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      if (verbose) process.stderr.write(d);
    });
    p.on('error', (e) =>
      reject(e.code === 'ENOENT' ? new Error(`"${cmd}" não encontrado. Instale e coloque no PATH.`) : e)
    );
    p.on('close', (code) => {
      children.delete(p);
      if (cancelled) return reject(new Error('Cancelado pelo usuário'));
      return code === 0 ? resolve(out) : reject(new Error(`${cmd} saiu com código ${code}\n${err.slice(-2000)}`));
    });
  });
}

export async function checkDeps() {
  for (const bin of ['ffmpeg', 'ffprobe', 'yt-dlp']) {
    await run(bin, ['--version']).catch(() => run(bin, ['-version']));
  }
  const filters = await run('ffmpeg', ['-hide_banner', '-filters']);
  if (!/^\s*\S*\s+ass\s/m.test(filters)) {
    throw new Error(
      'Seu ffmpeg não tem suporte a legendas (libass).\n' +
        'No Mac: brew uninstall ffmpeg && brew install ffmpeg-full\n' +
        '(se o ffmpeg-full não estiver no PATH, rode: brew link --overwrite ffmpeg-full)'
    );
  }
}

export const fmtTime = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
};

export const slug = (str) =>
  str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'corte';

let logSink = null;
/** Permite que o servidor web capture as mensagens de progresso. */
export const setLogSink = (fn) => { logSink = fn; };
export const log = (...a) => {
  console.log('\x1b[36m›\x1b[0m', ...a);
  if (logSink) logSink(a.join(' '));
};