#!/usr/bin/env node
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { missingKeys } from './config.js';
import { checkDeps, log, fmtTime } from './utils.js';
import { analyzeVod, renderJob, saveJob, vodIdFromUrl } from './pipeline.js';

const HELP = `
Uso: node src/index.js <link-do-video> [opções]

Opções:
  -n, --count <n>      Quantos cortes gerar (padrão: 10)
      --min <seg>      Duração mínima de cada corte (padrão: 20)
      --max <seg>      Duração máxima de cada corte (padrão: 60)
      --pre <seg>      Segundos extras ANTES do momento escolhido pela IA, para mostrar a jogada (padrão: 25)
  -l, --layout <tipo>  template | blur | crop | split (padrão: blur)
      --cam x,y,w,h    Posição da facecam em % da tela, para layout split (ex: 0,0,25,30)
  -o, --out <pasta>    Pasta de saída (padrão: ./output)
      --lang <código>  Idioma da live (padrão: pt)
      --quality <p>    Altura máx. do vídeo baixado (padrão: 1080)
      --no-teaser      Não coloca o teaser do ápice no começo do vídeo
      --dry-run        Só mostra os momentos encontrados, sem renderizar
  -h, --help           Mostra esta ajuda

Para revisar os textos antes de renderizar, use a interface web: npm run web

Exemplo:
  node src/index.js https://www.twitch.tv/videos/2283746123 -n 8 --layout split --cam 0,0,25,30
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    count: { type: 'string', short: 'n', default: '10' },
    min: { type: 'string', default: '20' },
    max: { type: 'string', default: '60' },
    pre: { type: 'string' },
    'no-teaser': { type: 'boolean', default: false },
    layout: { type: 'string', short: 'l', default: 'blur' },
    cam: { type: 'string' },
    out: { type: 'string', short: 'o', default: 'output' },
    lang: { type: 'string', default: process.env.LANGUAGE || 'pt' },
    quality: { type: 'string', default: '1080' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const url = positionals[0];
if (opt.help || !url) {
  console.log(HELP);
  process.exit(url ? 0 : 1);
}
if (!vodIdFromUrl(url)) {
  console.warn('⚠ O link não parece um vídeo da Twitch (twitch.tv/videos/123...) nem do YouTube. Tentando mesmo assim.');
}
for (const k of missingKeys()) {
  console.error(`Falta ${k} no arquivo .env (veja .env.example)`);
  process.exit(1);
}

async function main() {
  await checkDeps();

  const job = await analyzeVod(url, { count: opt.count, min: opt.min, max: opt.max, ...(opt.pre !== undefined ? { preRoll: Number(opt.pre) } : {}), lang: opt.lang });
  const clips = job.clips;

  if (!clips.length) {
    log('Nenhum momento forte encontrado. Tente diminuir --min ou aumentar --max.');
    return;
  }

  console.log('\nMomentos escolhidos:');
  clips.forEach((c, i) =>
    console.log(`  ${i + 1}. [${c.score}] ${fmtTime(c.start)}–${fmtTime(c.end)} (${Math.round(c.end - c.start)}s) ${c.title}`)
  );
  console.log();

  if (opt['dry-run']) return;

  const cam = opt.cam ? opt.cam.split(',').map(Number) : null;
  if (opt.layout === 'split' && (!cam || cam.length !== 4)) {
    console.error('Layout split precisa de --cam x,y,w,h (em %). Ex: --cam 0,0,25,30');
    process.exit(1);
  }

  job.opts = { ...job.opts, teaser: !opt['no-teaser'], layout: opt.layout, cam, quality: Number(opt.quality) };
  await renderJob(job);
  saveJob(job);
}

main().catch((e) => {
  console.error('\n✖', e.message);
  process.exit(1);
});
