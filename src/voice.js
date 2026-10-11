// Turns each scene's narration into a WAV file plus word timings.
// Results are cached per scene in build/voice/<scene>.json and only
// regenerated when the words, markers, voice, speed or pacing change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { speechChunks, resolveMarks } from './script.js';
import { alignWords } from './align.js';
import { loadTTS, transcribeWords, TTS_MODEL, ASR_MODEL, TTS_SAMPLE_RATE, ttsDtype } from './models.js';
import { writeWav, readWav, resample, trimSilence } from './wav.js';
import { resolveProvider, loadElevenLabs, elevenlabsSettings, elevenlabsSpeed } from './elevenlabs.js';

const PIPELINE = 7;

function sceneHash(scene, chunks, config, provider) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      PIPELINE,
      TTS_MODEL,
      ASR_MODEL,
      dtype: ttsDtype(),
      // Kokoro hashes stay as they were, so existing caches keep working.
      ...(provider === 'elevenlabs' ? { provider, elevenlabs: elevenlabsSettings(config) } : {}),
      voice: config.voice,
      speed: config.speed * config.pace,
      chunks: chunks.map((c) => [c.gapBefore, c.text]),
      // Markers and the shown text of each word are saved with the timings,
      // so moving a [#marker] or changing {shown|spoken} makes the scene again.
      layout: scene.units.map((u) => (u.type === 'mark' ? `#${u.name}` : u.type === 'word' ? u.display : '')).join('|'),
    }))
    .digest('hex')
    .slice(0, 16);
}

export function voicePaths(project, id) {
  return { wav: path.join(project.paths.voice, `${id}.wav`), json: path.join(project.paths.voice, `${id}.json`) };
}

export function readVoice(project, id) {
  const p = voicePaths(project, id);
  if (!fs.existsSync(p.json)) return null;
  try {
    return JSON.parse(fs.readFileSync(p.json, 'utf8'));
  } catch {
    return null;
  }
}

// Returns { [sceneId]: voiceInfo } and generates whatever is missing or stale.
export async function synthesize(project, { force = false, log = () => {}, only = null } = {}) {
  fs.mkdirSync(project.paths.voice, { recursive: true });
  const { config } = project;
  const result = {};
  const todo = [];
  const provider = resolveProvider(config, project.dir);
  for (const scene of project.script.scenes) {
    const chunks = speechChunks(scene.units, { sentenceGap: config.sentenceGap, paragraphGap: config.paragraphGap, pace: config.pace });
    const hash = sceneHash(scene, chunks, config, provider);
    const cached = readVoice(project, scene.id);
    const hasAudio = !chunks.length || fs.existsSync(voicePaths(project, scene.id).wav);
    if (!force && cached && cached.hash === hash && hasAudio) {
      result[scene.id] = cached;
    } else if (only && !only.includes(scene.id) && cached) {
      result[scene.id] = cached;
    } else {
      todo.push({ scene, chunks, hash });
    }
  }
  if (!todo.length) return result;

  const needsSpeech = todo.some((t) => t.chunks.length);
  if (needsSpeech) log(provider === 'elevenlabs' ? `voice: ElevenLabs (${elevenlabsSettings(config).voice}, ${elevenlabsSettings(config).model})` : 'voice: Kokoro (local)');
  const tts = !needsSpeech ? null : provider === 'elevenlabs' ? loadElevenLabs(config, project.dir) : await loadTTS({ log });
  for (const { scene, chunks, hash } of todo) {
    const t0 = Date.now();
    const info = await synthesizeScene(project, scene, chunks, hash, tts, log);
    result[scene.id] = info;
    if (chunks.length) {
      const warn = info.speechCheck === false ? ', speech check skipped (Whisper not available)' : info.matchRate < 0.85 ? `, check pronunciation (${Math.round(info.matchRate * 100)}% of words confirmed)` : '';
      log(`voice ${scene.id}: ${info.duration.toFixed(1)}s in ${((Date.now() - t0) / 1000).toFixed(1)}s${warn}`);
    }
  }
  return result;
}

let speechCheck = true;

async function synthesizeScene(project, scene, chunks, hash, tts, log) {
  const { config } = project;
  const files = voicePaths(project, scene.id);
  if (!chunks.length) {
    const info = { hash, id: scene.id, duration: 0, words: [], marks: resolveMarks(scene.units, []), chunks: [], transcript: '', matchRate: 1, unmatched: [] };
    if (fs.existsSync(files.wav)) fs.rmSync(files.wav);
    fs.writeFileSync(files.json, JSON.stringify(info, null, 2));
    return info;
  }
  const sr = TTS_SAMPLE_RATE;
  const pieces = [];
  let cursor = 0;
  const chunkInfo = [];
  const wordTimes = [];
  const transcripts = [];
  const unmatched = [];
  let matchedTokens = 0;
  let totalTokens = 0;
  let checked = true;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const gap = ci === 0 ? 0 : chunk.gapBefore;
    if (gap > 0) {
      pieces.push(new Float32Array(Math.round(gap * sr)));
      cursor += Math.round(gap * sr);
    }
    const eleven = tts.provider === 'elevenlabs';
    const audio = eleven
      ? await tts.generate(chunk.text, { speed: elevenlabsSpeed(config.speed, config.pace), previous: chunks[ci - 1]?.text, next: chunks[ci + 1]?.text, words: chunk.words })
      : await tts.generate(chunk.text, { voice: config.voice, speed: config.speed * config.pace });
    if ((audio.sampling_rate || sr) !== sr) throw new Error(`voice came back at ${audio.sampling_rate} Hz, expected ${sr} Hz`);
    const samples = trimSilence(audio.audio, sr);
    const trimmed = (samples.byteOffset - audio.audio.byteOffset) / samples.BYTES_PER_ELEMENT / sr;
    const start = cursor / sr;
    const dur = samples.length / sr;
    pieces.push(samples);
    cursor += samples.length;

    // Whisper hears the clip back. With Kokoro it also gives the word times;
    // ElevenLabs sends its own times, so there Whisper only checks the words
    // and may be missing (no network to download it, for example).
    let heard = null;
    if (!eleven || speechCheck) {
      try {
        heard = await transcribeWords(resample(samples, sr, 16000), { log });
      } catch (e) {
        if (!eleven) throw e;
        speechCheck = false;
        log(`speech check unavailable, using ElevenLabs timings only (${e.cause?.code || e.message})`);
      }
    }
    if (!heard) checked = false;
    transcripts.push(heard ? heard.text : '');
    const aligned = heard ? alignWords(chunk.words, heard.words, dur) : { words: [], matchRate: 1 };
    chunk.words.forEach((w, k) => {
      const a = eleven ? audio.words[k] : aligned.words[k];
      const t = (v) => Math.min(dur, Math.max(0, v - (eleven ? trimmed : 0)));
      const matched = heard ? aligned.words[k].matched : true;
      wordTimes[w.unitIndex] = { start: start + t(a.start), end: start + t(a.end), matched };
      if (!matched) unmatched.push(w.display);
    });
    const tokens = chunk.words.reduce((n, w) => n + w.spoken.split(/\s+/).length, 0);
    totalTokens += tokens;
    matchedTokens += aligned.matchRate * tokens;
    chunkInfo.push({ start, end: start + dur, text: chunk.text });
  }

  const total = new Float32Array(cursor);
  let off = 0;
  for (const p of pieces) {
    total.set(p, off);
    off += p.length;
  }
  writeWav(files.wav, total, sr);

  const words = [];
  scene.units.forEach((u, i) => {
    if (u.type !== 'word' || !wordTimes[i]) return;
    words.push({ text: u.display, spoken: u.spoken, start: round(wordTimes[i].start), end: round(wordTimes[i].end), matched: wordTimes[i].matched });
  });
  const info = {
    hash,
    id: scene.id,
    duration: round(cursor / sr),
    words,
    marks: Object.fromEntries(Object.entries(resolveMarks(scene.units, wordTimes)).map(([k, v]) => [k, round(v)])),
    chunks: chunkInfo.map((c) => ({ ...c, start: round(c.start), end: round(c.end) })),
    transcript: transcripts.join(' '),
    matchRate: totalTokens ? Math.round((matchedTokens / totalTokens) * 1000) / 1000 : 1,
    unmatched,
    provider: tts.provider || 'kokoro',
    ...(checked ? {} : { speechCheck: false }),
  };
  fs.writeFileSync(files.json, JSON.stringify(info, null, 2));
  return info;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

export function voiceSamples(project, id) {
  const p = voicePaths(project, id).wav;
  return fs.existsSync(p) ? readWav(p) : null;
}
