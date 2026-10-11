// Optional narration through the ElevenLabs API. Needs ELEVENLABS_API_KEY in
// the environment or in a .env file. The API returns the audio together with
// the time of every character, so word timings come from ElevenLabs itself.
import { findKey } from './env.js';
import { ProjectError } from './project.js';

export const ELEVENLABS_DEFAULTS = {
  voice: 'XrExE9yKIg1WjnnlVkGX', // Matilda, a premade American English narrator
  model: 'eleven_multilingual_v2',
  stability: 0.5,
  similarity: 0.75,
};
export const ELEVENLABS_SAMPLE_RATE = 24000;
const API = 'https://api.elevenlabs.io/v1';

export function elevenlabsKey(projectDir) {
  return findKey('ELEVENLABS_API_KEY', projectDir);
}

// "auto" uses ElevenLabs when a key is set, otherwise the local Kokoro voice.
export function resolveProvider(config, projectDir) {
  const tts = config.tts || 'auto';
  if (tts === 'auto') return elevenlabsKey(projectDir) ? 'elevenlabs' : 'kokoro';
  return tts;
}

export function elevenlabsSettings(config) {
  return { ...ELEVENLABS_DEFAULTS, ...(config.elevenlabs || {}) };
}

// explainroo's speed defaults to 0.9 because Kokoro talks fast. ElevenLabs
// talks at a natural pace at 1.0 and accepts 0.7 to 1.2.
export function elevenlabsSpeed(speed, pace = 1) {
  return Math.min(1.2, Math.max(0.7, Math.round(((speed * pace) / 0.9) * 100) / 100));
}

function pcm16ToFloat(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// words: [{ spoken }] joined by single spaces into text. Returns
// [{ start, end }] per word from the per-character alignment.
export function wordTimesFromAlignment(words, text, alignment, duration) {
  const chars = alignment?.characters || [];
  const starts = alignment?.character_start_times_seconds || [];
  const ends = alignment?.character_end_times_seconds || [];
  const exact = chars.join('') === text && starts.length === chars.length && ends.length === chars.length;
  const spans = [];
  let pos = 0;
  for (const w of words) {
    const from = text.indexOf(w.spoken, pos);
    const a = from < 0 ? pos : from;
    spans.push([a, a + w.spoken.length]);
    pos = a + w.spoken.length;
  }
  if (!exact) {
    // Spread the words over the clip by length when the alignment does not
    // line up with the text we sent.
    const total = Math.max(1, text.length);
    return spans.map(([a, b]) => ({ start: (a / total) * duration, end: (b / total) * duration, matched: false }));
  }
  return spans.map(([a, b]) => {
    let i = a;
    let j = b - 1;
    while (i < j && !/[\p{L}\p{N}]/u.test(chars[i])) i++;
    while (j > i && !/[\p{L}\p{N}]/u.test(chars[j])) j--;
    return { start: starts[i], end: Math.max(starts[i], ends[j]), matched: true };
  });
}

async function post(url, key, body) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      last = new ProjectError(`could not reach ElevenLabs (${e.cause?.code || e.message}). Behind a proxy, run with NODE_USE_ENV_PROXY=1.`);
      continue;
    }
    if (res.ok) return res.json();
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 401) throw new ProjectError(`ElevenLabs rejected the API key (401). Check ELEVENLABS_API_KEY. ${detail}`);
    if (res.status === 429 || res.status >= 500) {
      last = new ProjectError(`ElevenLabs answered ${res.status}: ${detail}`);
      continue;
    }
    throw new ProjectError(`ElevenLabs answered ${res.status}: ${detail}`);
  }
  throw last;
}

// Same shape as Kokoro's tts.generate, plus word timings.
export function loadElevenLabs(config, projectDir) {
  const key = elevenlabsKey(projectDir);
  if (!key) throw new ProjectError('ElevenLabs needs an API key. Set ELEVENLABS_API_KEY or put ELEVENLABS_API_KEY=... in a .env file in the explainroo folder.');
  const s = elevenlabsSettings(config);
  return {
    provider: 'elevenlabs',
    async generate(text, { speed = 1, previous, next, words } = {}) {
      const body = {
        text,
        model_id: s.model,
        voice_settings: { stability: s.stability, similarity_boost: s.similarity, speed },
      };
      if (previous) body.previous_text = previous;
      if (next) body.next_text = next;
      const url = `${API}/text-to-speech/${encodeURIComponent(s.voice)}/with-timestamps?output_format=pcm_${ELEVENLABS_SAMPLE_RATE}`;
      const r = await post(url, key, body);
      const audio = pcm16ToFloat(Buffer.from(r.audio_base64 || '', 'base64'));
      const duration = audio.length / ELEVENLABS_SAMPLE_RATE;
      const times = words ? wordTimesFromAlignment(words, text, r.alignment, duration) : null;
      return { audio, sampling_rate: ELEVENLABS_SAMPLE_RATE, words: times };
    },
  };
}
