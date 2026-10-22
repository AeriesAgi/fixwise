// Photo diagnosis: Amazon Nova Lite (multimodal, Bedrock Converse) looks at a customer's photo of the problem and
// returns a structured, conservative diagnosis. The image is validated by magic bytes, size-capped and never stored:
// only its SHA-256 is kept for the audit trail. The diagnosis then flows through the same safety triage, municipal
// routing and quoting as a spoken report, so a photo can never skip the safety-first rules.
import { createHash } from 'node:crypto';
export const VISION_MODEL = 'us.amazon.nova-lite-v1:0';
export const MAX_IMAGE_BYTES = 1_500_000;
const FORMATS = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const SEVERITIES = ['emergency', 'urgent', 'routine'];
const TRADES = ['plumbing', 'electrical', 'roofing', 'access', 'appliance', 'roads', 'streetlight', 'water', 'waste', 'other'];

export function decodeImage(b64, mediaType) {
  const fmt = FORMATS[mediaType];
  if (!fmt) return { error: 'Send a JPEG, PNG or WebP photo.' };
  const clean = String(b64 || '').replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(clean)) return { error: 'That photo could not be read.' };
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length < 200) return { error: 'That photo is too small to read.' };
  if (bytes.length > MAX_IMAGE_BYTES) return { error: 'That photo is too large. Send one under 1.5 MB.' };
  const magic = { jpeg: bytes[0] === 0xff && bytes[1] === 0xd8, png: bytes.subarray(1, 4).toString() === 'PNG', webp: bytes.subarray(8, 12).toString() === 'WEBP' };
  if (!magic[fmt]) return { error: 'That file is not the photo type it claims to be.' };
  return { bytes, format: fmt, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const PROMPT = `You are a careful South African home-repair and municipal-fault inspector. Look at the customer's photo.
Reply with ONLY a JSON object, no prose, with these keys:
{"is_repair_problem": true|false, "where": "home"|"street"|"unclear", "item": "the broken thing in 1-4 plain words, e.g. geyser, kitchen tap, pothole, street light, distribution board, gate motor, ceiling",
 "problem": "what you can actually see, one short sentence", "likely_cause": "most likely cause, one short sentence, hedged if unsure",
 "severity": "emergency"|"urgent"|"routine", "hazards": ["visible hazards such as exposed wires, water near electrics, sparking, smoke"],
 "trade": "plumbing"|"electrical"|"roofing"|"access"|"appliance"|"roads"|"streetlight"|"water"|"waste"|"other",
 "description": "one sentence in the customer's own words that names the item and the fault, e.g. 'the geyser is leaking from the pressure valve'. Use South African words: a water heater is a 'geyser'.",
 "confidence": 0.0-1.0}
Rules: describe only what is visible; never invent brands, prices or people; if the photo is not a repair problem, set is_repair_problem false.
Visible exposed or sparking wires, smoke, fire, or water on electrics are "emergency". Active water leaks are "urgent".`;

let clientP;
async function defaultBedrock(env) {
  clientP ??= import('@aws-sdk/client-bedrock-runtime').then(({ BedrockRuntimeClient, ConverseCommand }) => {
    const c = new BedrockRuntimeClient({ region: env.BEDROCK_REGION || env.AWS_REGION || 'us-east-1', maxAttempts: 1 });
    return { converse: (input, signal) => c.send(new ConverseCommand(input), { abortSignal: signal }) };
  });
  return clientP;
}
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export function parseDiagnosis(raw) {
  const m = /\{[\s\S]*\}/.exec(String(raw || '')); if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const conf = Math.max(0, Math.min(1, Number(j.confidence) || 0));
  return { isRepairProblem: j.is_repair_problem === true, where: ['home', 'street'].includes(j.where) ? j.where : 'unclear', item: str(j.item, 40),
    problem: str(j.problem, 200), likelyCause: str(j.likely_cause, 200), severity: SEVERITIES.includes(j.severity) ? j.severity : 'routine',
    hazards: (Array.isArray(j.hazards) ? j.hazards : []).map((h) => str(h, 80)).filter(Boolean).slice(0, 4),
    trade: TRADES.includes(j.trade) ? j.trade : 'other', description: str(j.description, 300), confidence: Math.round(conf * 100) / 100 };
}

export async function diagnoseImage(env, img, note = '') {
  const bedrock = env.VISION || await defaultBedrock(env);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), Number(env.VISION_TIMEOUT_MS || 6500)); const t0 = Date.now();
  try {
    const out = await bedrock.converse({ modelId: env.VISION_MODEL_ID || env.CONSOLE_MODEL_ID || VISION_MODEL,
      messages: [{ role: 'user', content: [{ image: { format: img.format, source: { bytes: img.bytes } } }, { text: PROMPT + (note ? `\nThe customer adds: "${str(note, 300)}"` : '') }] }],
      inferenceConfig: { maxTokens: 450, temperature: 0 } }, ac.signal);
    const text = (out?.output?.message?.content || []).filter((c) => c.text).map((c) => c.text).join(' ');
    return { dx: parseDiagnosis(text), ms: Date.now() - t0, usage: out?.usage ? { in: out.usage.inputTokens, out: out.usage.outputTokens } : null };
  } finally { clearTimeout(timer); }
}
