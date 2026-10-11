import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wordTimesFromAlignment, elevenlabsSpeed, resolveProvider } from '../src/elevenlabs.js';
import { normalizeConfig, loadProject, ProjectError } from '../src/project.js';

test('word times come from the per-character alignment and skip punctuation', () => {
  const text = 'Hello, big world.';
  const chars = [...text];
  const alignment = {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * 0.1),
    character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
  };
  const words = [{ spoken: 'Hello,' }, { spoken: 'big' }, { spoken: 'world.' }];
  const t = wordTimesFromAlignment(words, text, alignment, 2);
  assert.deepEqual(t.map((w) => [+w.start.toFixed(2), +w.end.toFixed(2)]), [[0, 0.5], [0.7, 1], [1.1, 1.6]]);
  assert.ok(t.every((w) => w.matched));
  // An alignment that does not match the text falls back to spreading by length.
  const loose = wordTimesFromAlignment(words, text, { characters: ['x'] }, 1.7);
  assert.equal(loose[0].start, 0);
  assert.ok(Math.abs(loose[2].end - 1.7) < 1e-9);
});

test('speed maps the Kokoro default to a natural ElevenLabs pace and stays in range', () => {
  assert.equal(elevenlabsSpeed(0.9, 1), 1);
  assert.equal(elevenlabsSpeed(0.9, 1.6), 1.2);
  assert.equal(elevenlabsSpeed(0.6, 1), 0.7);
});

test('tts setting is validated and "auto" follows the key', () => {
  assert.throws(() => normalizeConfig({ tts: 'polly' }), ProjectError);
  assert.throws(() => normalizeConfig({ elevenlabs: { voice: 'a b' } }), ProjectError);
  assert.throws(() => normalizeConfig({ elevenlabs: { colour: 1 } }), ProjectError);
  assert.equal(normalizeConfig({ elevenlabs: { voice: 'XrExE9yKIg1WjnnlVkGX', stability: 0.4 } }).tts, 'auto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-key-'));
  const saved = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    assert.equal(resolveProvider({ tts: 'elevenlabs' }, dir), 'elevenlabs');
    fs.writeFileSync(path.join(dir, '.env'), 'ELEVENLABS_API_KEY="abc"\n');
    assert.equal(resolveProvider({ tts: 'auto' }, dir), 'elevenlabs');
    assert.equal(resolveProvider({ tts: 'kokoro' }, dir), 'kokoro');
  } finally {
    if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
  }
});

test('voice step narrates with ElevenLabs and keeps its word timings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-eleven-'));
  fs.writeFileSync(path.join(dir, 'video.json'), JSON.stringify({ tts: 'elevenlabs' }));
  fs.writeFileSync(path.join(dir, 'script.md'), '# T\n\n## intro\nHello there. [#two] Second line.\n');
  fs.writeFileSync(path.join(dir, 'scenes.js'), 'export default { intro() {} };\n');
  const env = { ...process.env };
  process.env.ELEVENLABS_API_KEY = 'test-key';
  // No Whisper: the speech check is skipped and the ElevenLabs times are used.
  process.env.EXPLAINROO_OFFLINE = '1';
  process.env.EXPLAINROO_CACHE = path.join(dir, 'cache');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, key: init.headers['xi-api-key'] });
    const sr = 24000;
    const lead = 0.5; // silence the voice step trims off
    const per = 0.06;
    const n = Math.round((lead + body.text.length * per + 0.2) * sr);
    const pcm = Buffer.alloc(n * 2);
    for (let i = Math.round(lead * sr); i < n - 0.2 * sr; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 12000), i * 2);
    const chars = [...body.text];
    return new Response(JSON.stringify({
      audio_base64: pcm.toString('base64'),
      alignment: {
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => lead + i * per),
        character_end_times_seconds: chars.map((_, i) => lead + (i + 1) * per),
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { synthesize } = await import('../src/voice.js');
    const project = loadProject(dir);
    const voices = await synthesize(project);
    const v = voices.intro;
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /text-to-speech\/XrExE9yKIg1WjnnlVkGX\/with-timestamps\?output_format=pcm_24000/);
    assert.equal(calls[0].key, 'test-key');
    assert.equal(calls[0].body.next_text, 'Second line.');
    assert.equal(calls[1].body.previous_text, 'Hello there.');
    assert.equal(v.provider, 'elevenlabs');
    assert.equal(v.speechCheck, false);
    assert.deepEqual(v.words.map((w) => w.text), ['Hello', 'there.', 'Second', 'line.']);
    // The leading half second of silence is trimmed, so "Hello" starts near 0.
    assert.ok(v.words[0].start < 0.1, `first word at ${v.words[0].start}`);
    for (let i = 1; i < v.words.length; i++) assert.ok(v.words[i].start >= v.words[i - 1].end - 1e-6);
    assert.equal(v.marks.two, v.words[2].start);
    assert.ok(fs.existsSync(path.join(dir, 'build', 'voice', 'intro.wav')));
    // A second run is served from the cache.
    await synthesize(loadProject(dir));
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['ELEVENLABS_API_KEY', 'EXPLAINROO_OFFLINE', 'EXPLAINROO_CACHE']) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
});
