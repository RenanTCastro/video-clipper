// Provedor de transcrição: TRANSCRIBE_PROVIDER=local | groq | openai
// (TRANSCRIBE_BASE_URL / TRANSCRIBE_MODEL / TRANSCRIBE_API_KEY, se definidos, sobrescrevem o preset.)
const PRESETS = {
  local: { baseURL: 'http://localhost:8178/v1', model: 'whisper-1', apiKey: 'local', concurrency: 1 },
  groq: { baseURL: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3', keyName: 'GROQ_API_KEY', concurrency: 4 },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'whisper-1', keyName: 'OPENAI_API_KEY', concurrency: 4 },
};

export function transcribeConfig(env = process.env) {
  const explicit = env.TRANSCRIBE_PROVIDER?.toLowerCase();
  // compatibilidade com .env antigo (só TRANSCRIBE_BASE_URL)
  const legacy = !explicit && env.TRANSCRIBE_BASE_URL;
  const name = explicit || (legacy ? 'custom' : 'local');
  const p = PRESETS[name] || {};
  return {
    provider: name,
    baseURL: env.TRANSCRIBE_BASE_URL || p.baseURL || PRESETS.openai.baseURL,
    model: env.TRANSCRIBE_MODEL || p.model || 'whisper-1',
    apiKey: env.TRANSCRIBE_API_KEY || (p.keyName && env[p.keyName]) || p.apiKey,
    concurrency: Number(env.TRANSCRIBE_CONCURRENCY) || p.concurrency || 4,
    keyName: p.keyName || 'TRANSCRIBE_API_KEY',
  };
}

/** Variáveis obrigatórias que estão faltando no .env. */
export function missingKeys(env = process.env) {
  const t = transcribeConfig(env);
  const missing = [];
  if (!env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!t.apiKey) missing.push(t.keyName);
  return missing;
}
