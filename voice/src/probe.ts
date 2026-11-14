// Test without a microphone: joins a conversation's room as the person, says
// each phrase (synthesized to audio first), records what the agent says back,
// and prints the agent's notes plus a transcript of the recording.
// Usage: tsx src/probe.ts <conversationId> "phrase one" "phrase two" ...
// A phrase "wait:N" waits N seconds without speaking.
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind,
  TrackPublishOptions, TrackSource, dispose,
} from '@livekit/rtc-node';
import { pickVoice } from './speech.ts';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '../../.env'), quiet: true });
const key = process.env.ELEVENLABS_API_KEY!;
const [conversationId, ...phrases] = process.argv.slice(2);
const RATE = 16_000;
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function speechPcm(text: string): Promise<Int16Array> {
  const voice = await pickVoice(key);
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  const out = new Int16Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
  return out;
}

const { url, token } = await (await fetch(`http://localhost:4200/token?conversationId=${conversationId}`)).json() as any;
const room = new Room();
const recorded: Int16Array[] = [];
room.on(RoomEvent.TrackSubscribed, async (track) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  const stream = new AudioStream(track, RATE, 1);
  for await (const f of stream as any as AsyncIterable<AudioFrame>) recorded.push(new Int16Array(f.data));
});
room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
  if (topic === 'voice') console.log(`${ts()} agent says: ${new TextDecoder().decode(payload)}`);
});
await room.connect(url, token, { autoSubscribe: true, dynacast: false });
const source = new AudioSource(RATE, 1);
const track = LocalAudioTrack.createAudioTrack('mic', source);
const opts = new TrackPublishOptions();
opts.source = TrackSource.SOURCE_MICROPHONE;
await room.localParticipant!.publishTrack(track, opts);
// VOICE_PTT=1 speaks the way the page does: microphone on for each phrase, off after it.
const ptt = process.env.VOICE_PTT === '1';
const mic = track as unknown as { mute?: () => unknown; unmute?: () => unknown };
if (ptt) { console.log(`${ts()} push to talk (mute available: ${typeof mic.mute === 'function'})`); await mic.mute?.(); }

// Silence keeps the stream going between phrases, like a real open microphone.
const FRAME = RATE / 100;
const silence = new Int16Array(FRAME);
async function play(pcm: Int16Array) {
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    await source.captureFrame(new AudioFrame(pcm.slice(i, i + FRAME), RATE, 1, FRAME));
  }
}
async function quiet(seconds: number) {
  for (let i = 0; i < seconds * 100; i++) await source.captureFrame(new AudioFrame(silence, RATE, 1, FRAME));
}

await quiet(1.5);
for (const p of phrases) {
  const m = /^wait:(\d+(?:\.\d+)?)$/.exec(p);
  if (m) { await quiet(Number(m[1])); continue; }
  const pcm = await speechPcm(p);
  console.log(`${ts()} person says: ${p}`);
  if (ptt) { await mic.unmute?.(); await quiet(0.3); }
  await play(pcm);
  if (ptt) { await quiet(0.2); await mic.mute?.(); } else await quiet(1);
}
await quiet(2);

// Save and transcribe what the agent said.
const total = recorded.reduce((n, a) => n + a.length, 0);
const pcm = Buffer.alloc(total * 2);
let o = 0;
for (const a of recorded) for (const s of a) { pcm.writeInt16LE(s, o); o += 2; }
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const wav = Buffer.concat([header, pcm]);
const file = join(here, '../logs/probe-agent.wav');
writeFileSync(file, wav);
console.log(`${ts()} recorded ${(total / RATE).toFixed(1)} s of the agent's audio → ${file}`);
const form = new FormData();
form.append('model_id', 'scribe_v1');
form.append('file', new Blob([wav], { type: 'audio/wav' }), 'agent.wav');
const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form });
const j: any = await r.json();
console.log(`What the agent's audio says: ${r.ok ? j.text : JSON.stringify(j).slice(0, 200)}`);
await room.disconnect();
await dispose();
process.exit(0);
