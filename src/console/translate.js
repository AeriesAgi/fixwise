// Afrikaans and isiZulu in the console: Nova Lite translates the customer's words to English for the planner and the
// tools, and Alexa's reply back. Names, case references and rand amounts are kept exactly. Amazon Polly has no Afrikaans
// or isiZulu voice, so these languages are spoken by the device's own voice if it has one, otherwise captions only.
import { DEFAULT_MODEL } from './planner.js';

export const LANGS = { af: { name: 'Afrikaans', sr: 'af-ZA' }, zu: { name: 'isiZulu', sr: 'zu-ZA' } };
let clientP;
async function bedrockOf(env) {
  if (env.TRANSLATE) return env.TRANSLATE;
  if (env.BEDROCK) return env.BEDROCK;
  clientP ??= import('@aws-sdk/client-bedrock-runtime').then(({ BedrockRuntimeClient, ConverseCommand }) => {
    const c = new BedrockRuntimeClient({ region: env.BEDROCK_REGION || env.AWS_REGION || 'us-east-1', maxAttempts: 1 });
    return { converse: (input, signal) => c.send(new ConverseCommand(input), { abortSignal: signal }) };
  });
  return clientP;
}

export async function translate(env, text, from, to) {
  const t = String(text || '').slice(0, 800); if (!t.trim()) return { text: t, ms: 0 };
  const t0 = Date.now(); const br = await bedrockOf(env);
  const name = (c) => (c === 'en' ? 'South African English' : LANGS[c].name);
  const system = `You translate short home-repair conversations from ${name(from)} to ${name(to)}. Output only the translation, no notes or quotes. Keep supplier names, case and booking references (like CO 12345, BK 3F2A1C), times, and rand amounts (like R2,967) exactly as written. Keep it natural and spoken.${to === 'af' ? " In Afrikaans a geyser is 'geiser' and a plumber is 'loodgieter'." : ''}${to === 'zu' ? ' Use simple, everyday isiZulu; keep the word geyser.' : ''}`;
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), Number(env.TRANSLATE_TIMEOUT_MS || 4000));
  try {
    const out = await br.converse({ modelId: env.CONSOLE_MODEL_ID || DEFAULT_MODEL, system: [{ text: system }], messages: [{ role: 'user', content: [{ text: t }] }], inferenceConfig: { maxTokens: 300, temperature: 0 } }, ac.signal);
    const s = (out.output?.message?.content || []).map((c) => c.text || '').join('').trim();
    return { text: s || t, ms: Date.now() - t0, ok: !!s };
  } finally { clearTimeout(timer); }
}
