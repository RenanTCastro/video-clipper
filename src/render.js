import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './utils.js';

const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/** Lê templates/<nome>/template.json e resolve o caminho da arte (overlay com furo transparente). */
export function loadTemplate(name = 'gta6') {
  if (!/^[\w-]+$/.test(name)) throw new Error('Nome de template inválido.');
  const dir = path.join(TEMPLATES_DIR, name);
  const file = path.join(dir, 'template.json');
  if (!fs.existsSync(file)) throw new Error(`Template "${name}" não encontrado em templates/${name}/`);
  const tpl = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...tpl, id: name, overlayFile: path.join(dir, tpl.overlay) };
}

/**
 * Converte um trecho horizontal (16:9) em vertical 1080x1920 com legenda queimada.
 *
 * Layouts:
 *  - "blur": vídeo inteiro no meio, fundo com o próprio vídeo desfocado (não perde nada da tela)
 *  - "crop": corta o centro da imagem e preenche a tela toda (bom para câmera/IRL)
 *  - "template": vídeo dentro da moldura de uma arte (PNG com furo transparente), com título e legenda nas áreas da arte
 *  - "split": metade de cima = facecam, metade de baixo = gameplay (passe --cam x,y,w,h em % da tela)
 */
export async function renderVertical(input, assFile, output, { layout = 'blur', cam = null, template = null, teaser = null } = {}) {
  // O ffmpeg roda dentro da pasta da legenda, assim passamos só nomes relativos e simples
  // (evita problemas de escape com espaços, ":" e aspas em caminhos absolutos).
  const cwd = path.dirname(path.resolve(assFile));
  const fontsDir = path.resolve('fonts');
  const fontsOpt = fs.existsSync(fontsDir) ? `:fontsdir=${path.relative(cwd, fontsDir).replace(/\\/g, '/')}` : '';
  const subs = `ass=filename=${path.basename(assFile)}${fontsOpt}`;

  let filter;
  let extraInputs = [];
  if (layout === 'template' && template) {
    // vídeo por trás, arte por cima (o furo transparente deixa o vídeo aparecer). Margem de 4px
    // para o vídeo passar por baixo da borda neon e não sobrar fresta.
    const { x, y, w, h } = template.video;
    const m = 4;
    filter =
      `color=c=black:s=1080x1920:r=30[base];` +
      `[0:v]scale=${w + 2 * m}:${h + 2 * m}:force_original_aspect_ratio=increase,crop=${w + 2 * m}:${h + 2 * m},setsar=1[vid];` +
      `[base][vid]overlay=${x - m}:${y - m}:shortest=1[t1];` +
      `[t1][1:v]overlay=0:0,setsar=1,${subs}[v]`;
    extraInputs = ['-framerate', '30', '-loop', '1', '-i', path.resolve(template.overlayFile)];
  } else if (layout === 'crop') {
    filter = `[0:v]scale=-2:1920,crop=1080:1920,setsar=1,${subs}[v]`;
  } else if (layout === 'split' && cam) {
    const [cx, cy, cw, ch] = cam.map((n) => n / 100);
    filter =
      `[0:v]split=2[a][b];` +
      `[a]crop=iw*${cw}:ih*${ch}:iw*${cx}:ih*${cy},scale=1080:768:force_original_aspect_ratio=increase,crop=1080:768[cam];` +
      `[b]scale=-2:1152,crop=1080:1152[game];` +
      `[cam][game]vstack=inputs=2,setsar=1,${subs}[v]`;
  } else {
    filter =
      `[0:v]split=2[a][b];` +
      `[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:5,eq=brightness=-0.15[bg];` +
      `[b]scale=1080:-2[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,${subs}[v]`;
  }

  // Teaser: antes do corte, repete o trecho do ápice (teaser.from/len em segundos, relativos ao início do vídeo baixado)
  let audioMap = '0:a?';
  if (teaser) {
    const a = teaser.from.toFixed(3), b = (teaser.from + teaser.len).toFixed(3);
    filter =
      `[0:v]split=2[tm][tt];[tt]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[tv];[tm]setpts=PTS-STARTPTS[mv];[tv][mv]concat=n=2:v=1:a=0[src];` +
      `[0:a]asplit=2[am][at];[at]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[ta];[am]asetpts=PTS-STARTPTS[ma];[ta][ma]concat=n=2:v=0:a=1[aout];` +
      filter.replace('[0:v]', '[src]');
    audioMap = '[aout]';
  }

  await run('ffmpeg', [
    '-y', '-i', path.resolve(input), ...extraInputs,
    '-filter_complex', filter,
    '-map', '[v]', '-map', audioMap,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart', '-r', '30', ...(extraInputs.length ? ['-shortest'] : []),
    path.resolve(output),
  ], { cwd });
  return output;
}