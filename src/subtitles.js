/**
 * Gera legendas no formato ASS, no estilo dos cortes virais:
 * poucas palavras por vez, fonte grossa, palavra falada destacada em amarelo.
 */

const WORDS_PER_LINE = 3;

const toAssTime = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

const esc = (s) => s.replace(/[{}\\]/g, '').replace(/\n/g, ' ');

/** Quebra o título em até 3 linhas (\\N do ASS) e escolhe o tamanho da fonte pelo nº de linhas. */
function wrapTitle(text, { maxChars = 15, sizes = [124, 108, 88] } = {}) {
  const lines = [];
  let cur = '';
  for (const w of text.trim().toUpperCase().split(/\s+/).filter(Boolean)) {
    if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) { lines.length = 3; lines[2] = lines[2].replace(/[ ,.!?…-]+$/, '') + '…'; }
  return { lines, size: sizes[Math.min(lines.length, sizes.length) - 1] };
}

export function buildAss(words, clipStart, clipEnd, { hook = '', title = '', tpl = null, teaser = null, width = 1080, height = 1920, highlight = '00FFFF' } = {}) {
  // highlight em BGR (ASS): 00FFFF = amarelo
  // teaser = { from, to } (segundos absolutos): trecho do ápice que entra ANTES do corte; o corte inteiro fica deslocado por (to - from)
  const tlen = teaser ? teaser.to - teaser.from : 0;
  const localize = (from, to, offset) =>
    words
      .filter((w) => w.end > from && w.start < to && w.word)
      .map((w) => ({
        start: Math.max(from, w.start) - from + offset,
        end: Math.min(to, w.end) - from + offset,
        text: esc(w.word).toUpperCase(),
      }));
  const total = clipEnd - clipStart + tlen;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Montserrat Black,92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,7,3,2,60,60,560,1
Style: Title,Montserrat Black,110,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,0,6,5,60,60,0,1
Style: Hook,Montserrat Black,70,&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,18,0,8,80,80,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];

  if (tpl && title.trim()) {
    const t = wrapTitle(title, tpl.title);
    events.push(`Dialogue: 1,${toAssTime(0)},${toAssTime(total)},Title,,0,0,0,,{\\an5\\pos(${width / 2},${tpl.title?.y ?? 480})\\fs${t.size}}${t.lines.map(esc).join('\\N')}`);
  } else if (hook) {
    events.push(`Dialogue: 1,${toAssTime(0)},${toAssTime(Math.min(4, total))},Hook,,0,0,0,,{\\fad(150,300)}${esc(hook).toUpperCase()}`);
  }

  // agrupa em linhas de N palavras, quebrando também em pausas longas
  const addCaptions = (local, limit = Infinity) => {
  const groups = [];
  let cur = [];
  for (const w of local) {
    const prev = cur[cur.length - 1];
    if (cur.length >= WORDS_PER_LINE || (prev && w.start - prev.end > 0.6)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  groups.forEach((g, gi) => {
    const groupEnd = gi + 1 < groups.length ? Math.min(groups[gi + 1][0].start, g[g.length - 1].end + 0.5) : g[g.length - 1].end + 0.3;
    // um evento por palavra, para destacar a palavra que está sendo falada
    g.forEach((w, wi) => {
      const s = w.start;
      const e = Math.min(limit, wi + 1 < g.length ? g[wi + 1].start : groupEnd);
      if (e <= s) return;
      const text = g
        .map((x, xi) =>
          xi === wi ? `{\\c&H${highlight}&\\t(0,80,\\fscx112\\fscy112)\\t(80,160,\\fscx100\\fscy100)}${x.text}{\\c&HFFFFFF&}` : x.text
        )
        .join(' ');
      // template: legenda centralizada na área "tradução" da arte, com fonte menor se a linha for longa
      let place = '';
      if (tpl) {
        const cap = tpl.caption || {};
        const chars = g.reduce((n, x) => n + x.text.length + 1, 0);
        const size = Math.round((cap.size || 84) * Math.min(1, (cap.maxChars || 17) / Math.max(chars, 1)));
        place = `{\\an5\\pos(${width / 2},${cap.y ?? 1405})\\fs${size}}`;
      }
      const pop = wi === 0 ? '{\\fscx85\\fscy85\\t(0,90,\\fscx100\\fscy100)}' : '';
      events.push(`Dialogue: 0,${toAssTime(s)},${toAssTime(e)},Caption,,0,0,0,,${place}${pop}${text}`);
    });
  });
  };

  if (teaser) addCaptions(localize(teaser.from, teaser.to, 0), tlen);
  addCaptions(localize(clipStart, clipEnd, tlen));

  return header + events.join('\n') + '\n';
}
