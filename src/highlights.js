import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { log, fmtTime, checkCancel } from './utils.js';

const WINDOW = 25 * 60; // analisa a live em janelas de 25 min
const OVERLAP = 3 * 60; // com 3 min de sobreposição pra não cortar momento no meio

const SYSTEM = `Você é um editor de vídeo especialista em cortes virais de lives da Twitch para TikTok, Reels e YouTube Shorts.
Você recebe um trecho da transcrição com timestamps (em segundos) e encontra os momentos com maior potencial de viralizar.

Procure por: reações fortes (raiva, susto, risada, choque), jogadas épicas ou fails, histórias engraçadas ou polêmicas,
opiniões fortes, frases de efeito, interações marcantes com o chat, momentos emocionais, revelações e "plot twists".

IMPORTANTE — o corte precisa MOSTRAR a jogada, não só a reação a ela:
- A transcrição só tem a fala do streamer. A jogada em si (a kill, o clutch, o fail, o susto) quase sempre acontece ANTES da fala/risada/comentário que aparece na transcrição: o streamer reage depois de acontecer.
- Quando você achar uma reação forte (risada, grito, "caralho", "que isso", comentando o que acabou de acontecer), olhe as linhas ANTERIORES para entender o que causou aquilo. Essa é a jogada, e ela tem que estar dentro do corte, com a reação vindo depois.
- Descarte trechos que são só o streamer rindo ou comentando algo que já passou, sem a ação aparecer no corte. Prefira momentos com ação seguida de reação.
- Informe "start" no começo da jogada ou, se a transcrição não mostrar quando ela começou, no começo da reação. O sistema adiciona automaticamente alguns segundos ANTES do "start" que você informar (para garantir que a jogada apareça), então não precisa se preocupar com contexto anterior.
- O corte termina logo depois da reação principal (poucos segundos). Não estenda com muito papo sobre o que já aconteceu.

TÍTULO = GANCHO DE CURIOSIDADE (aparece grande no topo do vídeo e decide se a pessoa fica):
- Curto: 3 a 6 palavras, no máximo 45 caracteres.
- Desperta curiosidade ou promete algo SEM entregar o desfecho. Ex.: "Ele NÃO esperava isso", "Olha o que acontece no fim", "Ninguém viu esse cara", "Isso deu muito errado".
- Evite descrição seca do que acontece (ex.: "Fechou a porta na cara do parceiro") e evite spoiler do final.
- Pode usar pergunta, mas não use emojis nem aspas.

ÁPICE (teaser): informe em "peak" o segundo exato do instante mais forte do corte (o grito, a reação máxima, o desfecho da jogada). O sistema vai mostrar ~3s desse instante no início do vídeo, como teaser, antes de voltar para a jogada completa. "peak" precisa estar entre "start" e "end".

Regras para cada corte:
- Precisa fazer sentido sozinho, sem contexto da live.
- Começa direto no gancho (nada de "então galera..."), nos primeiros 3 segundos já prende.
- Termina num ponto natural (fim da piada, da reação, da frase) — nunca no meio de uma frase.
- Use os timestamps da transcrição para start/end.
- Na justificativa ("reason"), diga qual é a jogada/ação e onde ela acontece em relação à reação.
- Seja exigente: só devolva momentos realmente bons. Pode devolver lista vazia.`;

const TOOL = {
  name: 'salvar_cortes',
  description: 'Salva os momentos candidatos a corte encontrados no trecho.',
  input_schema: {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            start: { type: 'number', description: 'Início em segundos' },
            end: { type: 'number', description: 'Fim em segundos' },
            title: { type: 'string', description: 'Gancho de curiosidade para o topo do vídeo: 3 a 6 palavras, máx 45 caracteres, sem entregar o desfecho' },
            hook: { type: 'string', description: 'Texto de gancho para aparecer no topo do vídeo (máx 40 caracteres)' },
            peak: { type: 'number', description: 'Segundo exato do ápice do corte (entre start e end), usado como teaser no início do vídeo' },
            reason: { type: 'string', description: 'Por que esse momento tem potencial viral' },
            score: { type: 'integer', minimum: 1, maximum: 100, description: 'Potencial viral de 1 a 100' },
          },
          required: ['start', 'end', 'title', 'hook', 'peak', 'reason', 'score'],
        },
      },
    },
    required: ['clips'],
  },
};

export async function findHighlights(transcript, workDir, opts) {
  const { duration, count, minLen, maxLen, preRoll = 0, vodTitle, concurrency = 3 } = opts;
  // v3 = prompt que procura a jogada + título-gancho + ápice (peak); caches de versões anteriores são ignorados
  const cache = path.join(workDir, `highlights_v3_${minLen}-${maxLen}.json`);
  let candidates;

  if (fs.existsSync(cache)) {
    log('Usando análise de momentos em cache');
    candidates = JSON.parse(fs.readFileSync(cache, 'utf8'));
  } else {
    const client = new Anthropic();
    const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

    const windows = [];
    for (let s = 0; s < duration; s += WINDOW - OVERLAP) {
      windows.push([s, Math.min(s + WINDOW, duration)]);
      if (s + WINDOW >= duration) break;
    }

    const all = [];
    let next = 0;
    let done = 0;
    async function worker() {
      while (next < windows.length) {
        checkCancel();
        const [ws, we] = windows[next++];
        const lines = transcript.segments
          .filter((s) => s.start >= ws && s.start < we && s.text)
          .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`);
        if (lines.length < 5) { done++; continue; }

        const msg = await client.messages.create({
          model,
          max_tokens: 4096,
          system: SYSTEM,
          tools: [TOOL],
          tool_choice: { type: 'auto' },
          messages: [{
            role: 'user',
            content:
              `Live: "${vodTitle}"\nTrecho de ${fmtTime(ws)} a ${fmtTime(we)}.\n` +
              `Cada corte deve ter entre ${minLen} e ${maxLen} segundos.\n\n` +
              `<transcricao>\n${lines.join('\n')}\n</transcricao>\n\n` +
              `Responda SEMPRE chamando a ferramenta ${TOOL.name} (com clips vazio se não houver nada bom).`,
          }],
        });
        const clips = extractClips(msg);
        all.push(...clips);
        done++;
        log(`Analisado ${done}/${windows.length} trechos — ${clips.length} candidatos`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));
    candidates = all;
    fs.writeFileSync(cache, JSON.stringify(candidates, null, 2));
  }

  return pickBest(candidates, transcript, { count, minLen, maxLen, preRoll, duration });
}

/** Lê os cortes da chamada de ferramenta ou, se o modelo respondeu em texto, de um JSON no texto. */
function extractClips(msg) {
  const tool = msg.content.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
  if (tool) return Array.isArray(tool.input?.clips) ? tool.input.clips : [];
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const match = text.match(/\{[\s\S]*"clips"[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    const clips = Array.isArray(parsed) ? parsed : parsed.clips;
    return (clips || []).filter((c) => typeof c.start === 'number' && typeof c.end === 'number');
  } catch {
    return [];
  }
}

/** Ajusta limites, remove duplicados (janelas sobrepostas) e pega os de maior score. */
function pickBest(candidates, transcript, { count, minLen, maxLen, preRoll = 0, duration }) {
  const fixed = candidates
    .map((c) => {
      let start = Math.max(0, c.start);
      const origStart = start;
      let end = Math.min(duration, c.end);
      if (end - start > maxLen) end = start + maxLen;
      if (end - start < minLen) end = Math.min(duration, start + minLen);
      // pré-roll: começa antes do momento escolhido, para a jogada aparecer (a IA tende a marcar a reação)
      start = Math.max(0, start - preRoll);
      ({ start, end } = snapToWords(start, end, transcript.words));
      const peak = Number.isFinite(c.peak) && c.peak >= origStart && c.peak <= end ? Math.round(c.peak * 10) / 10 : null;
      return { ...c, start, end, peak };
    })
    .filter((c) => c.end > c.start)
    .sort((a, b) => b.score - a.score);

  const chosen = [];
  for (const c of fixed) {
    const overlaps = chosen.some((o) => Math.min(o.end, c.end) - Math.max(o.start, c.start) > 0.3 * (c.end - c.start));
    if (!overlaps) chosen.push(c);
    if (chosen.length >= count) break;
  }
  return chosen;
}

/** Faz o corte começar/terminar exatamente em fronteiras de palavras, com respiro. */
function snapToWords(start, end, words) {
  if (!words.length) return { start, end };
  const first = words.find((w) => w.end > start);
  const lastIdx = words.findLastIndex((w) => w.start < end);
  const last = lastIdx >= 0 ? words[lastIdx] : null;
  return {
    start: first ? Math.max(0, first.start - 0.15) : start,
    end: last ? last.end + 0.4 : end,
  };
}