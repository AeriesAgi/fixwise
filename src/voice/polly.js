// Spoken replies for the simulated Alexa+ console: Amazon Polly neural TTS, paid from AWS credits only.
// Distinct assistant voice (not the Alexa voice): Ayanda, Polly's South African English neural voice.
// Guard rails: per-IP and global hourly caps, a 600-character cap per request, and a text-hash cache in the store
// so a repeated line (every demo says the same safety steps) is synthesised once.
import { createHash } from 'node:crypto';
export const VOICES = { 'en-ZA': { id: 'Ayanda', lang: 'en-ZA' }, 'en-GB': { id: 'Arthur', lang: 'en-GB' } };
export const MAX_CHARS = 600;
let pollyP;
async function defaultPolly(env) {
  pollyP ??= import('@aws-sdk/client-polly').then(({ PollyClient, SynthesizeSpeechCommand }) => {
    const c = new PollyClient({ region: env.POLLY_REGION || env.AWS_REGION || 'us-east-1', maxAttempts: 2 });
    return { synth: async (input) => { const r = await c.send(new SynthesizeSpeechCommand(input)); return Buffer.from(await r.AudioStream.transformToByteArray()); } };
  });
  return pollyP;
}
export const cleanForSpeech = (t) => String(t || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
export async function synthesize(env, text, voiceKey = 'en-ZA') {
  const v = VOICES[voiceKey] || VOICES['en-ZA']; const t = cleanForSpeech(text);
  const key = `tts:${v.id}:${createHash('sha256').update(t).digest('hex').slice(0, 40)}`;
  const hit = await env.KV.get(key);
  if (hit) return { audio: Buffer.from(hit, 'base64'), cached: true, voice: v.id };
  const polly = env.POLLY || await defaultPolly(env);
  const audio = await polly.synth({ Engine: 'neural', VoiceId: v.id, LanguageCode: v.lang, OutputFormat: 'mp3', SampleRate: '24000', TextType: 'text', Text: t });
  if (audio.length < 300000) await env.KV.put(key, audio.toString('base64'), { expirationTtl: 30 * 86400 });
  return { audio, cached: false, voice: v.id };
}
