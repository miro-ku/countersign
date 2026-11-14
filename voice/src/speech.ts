// Hearing and speaking through ElevenLabs: a streaming listener with
// end-of-turn detection, and sentence-sized text to speech.
import WebSocket from 'ws';

export const SPEAK_RATE = 24_000; // Hz, mono PCM16 spoken into the room
export const HEAR_RATE = 16_000; // Hz, mono PCM16 sent to the listener

export interface ListenerEvents {
  partial(text: string): void;
  final(text: string): void;
  error(message: string): void;
}

/** One realtime transcription session; reopens itself when it drops. */
export class Listener {
  private ws: WebSocket | null = null;
  private ready = false;
  private pending: Buffer[] = [];
  private closed = false;

  constructor(private apiKey: string, private on: ListenerEvents) {}

  private open() {
    const qs = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      // Long enough that a breath mid-sentence does not end the turn; turning
      // the microphone off ends it at once (see endTurn).
      vad_silence_threshold_secs: '1.0',
      language_code: 'en',
      // Murmurs and fillers are left out of the transcript.
      no_verbatim: 'true',
    });
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs}`, {
      headers: { 'xi-api-key': this.apiKey },
    });
    this.ws = ws;
    this.ready = false;
    ws.on('open', () => {
      this.ready = true;
      for (const b of this.pending.splice(0)) this.sendNow(b);
    });
    ws.on('message', (raw) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      const t = m.message_type;
      if (t === 'partial_transcript') { if (m.text?.trim()) this.on.partial(m.text.trim()); }
      else if (t === 'committed_transcript') { if (m.text?.trim()) this.on.final(m.text.trim()); }
      else if (t !== 'session_started' && t !== 'committed_transcript_with_timestamps' && (m.error || /error|exceeded|limited|throttled|overflow|exhausted/.test(t))) {
        this.on.error(`${t}: ${m.error ?? ''}`);
      }
    });
    ws.on('close', () => { if (this.ws === ws) this.ws = null; });
    ws.on('error', (e) => this.on.error(`listener socket: ${e.message}`));
  }

  private sendNow(pcm: Buffer) {
    this.ws?.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: pcm.toString('base64'),
      commit: false,
      sample_rate: HEAR_RATE,
    }));
  }

  /** Mono PCM16 at HEAR_RATE. */
  push(pcm: Buffer) {
    if (this.closed) return;
    if (!this.ws) this.open();
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.sendNow(pcm);
    else if (this.pending.length < 50) this.pending.push(pcm);
  }

  /** The person stopped talking (their microphone went off): hear silence, so the turn ends now. */
  endTurn() {
    if (this.closed || !this.ws) return;
    const quarter = Buffer.alloc((HEAR_RATE / 4) * 2);
    for (let i = 0; i < 6; i++) this.push(quarter);
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}

/** A WAV file around mono PCM16 at HEAR_RATE. */
function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(HEAR_RATE, 24);
  header.writeUInt32LE(HEAR_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Voice isolation takes nothing shorter than this, so a short turn is padded with silence.
const ISOLATE_MIN_SECS = 5;

/** The person's voice with the room taken out; null when that could not be had in time. */
async function isolate(apiKey: string, pcm: Buffer, timeoutMs: number): Promise<Blob | null> {
  const wanted = ISOLATE_MIN_SECS * HEAR_RATE * 2;
  const padded = pcm.length >= wanted ? pcm : Buffer.concat([pcm, Buffer.alloc(wanted - pcm.length)]);
  const form = new FormData();
  form.append('audio', new Blob([wav(padded)], { type: 'audio/wav' }), 'turn.wav');
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/audio-isolation', {
      method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[voice] isolation refused (${res.status}): ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    return await res.blob();
  } catch (e: any) {
    console.warn(`[voice] isolation skipped: ${e.message}`);
    return null;
  }
}

export interface TurnTranscript { text: string; isolated: boolean; ms: number }

/**
 * One whole turn, heard again from start to end by the full transcription
 * model, told which names to listen for. About half a second slower than the
 * live transcript, and better with names.
 */
export async function transcribeTurn(apiKey: string, pcm: Buffer, keyterms: string[]): Promise<TurnTranscript> {
  const started = Date.now();
  // Off unless asked for: with a second voice nearby, isolation brought that voice forward
  // and the transcript followed it (spikes/voice/turnCheck.mts).
  const clean = process.env.VOICE_ISOLATION === 'on' ? await isolate(apiKey, pcm, 4000) : null;
  const form = new FormData();
  form.append('model_id', process.env.VOICE_STT_MODEL || 'scribe_v2');
  form.append('language_code', 'en');
  form.append('no_verbatim', 'true');
  form.append('tag_audio_events', 'false');
  for (const term of keyterms.slice(0, 100)) form.append('keyterms', term);
  if (clean) form.append('file', clean, 'turn.mp3');
  else form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'turn.wav');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`speech to text failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
  const body = (await res.json()) as { text?: string };
  return { text: (body.text ?? '').trim(), isolated: clean !== null, ms: Date.now() - started };
}

let voiceIdCache: string | null = null;

export async function pickVoice(apiKey: string): Promise<string> {
  if (process.env.ELEVENLABS_VOICE_ID) return process.env.ELEVENLABS_VOICE_ID;
  if (voiceIdCache) return voiceIdCache;
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
  if (!r.ok) throw new Error(`could not list voices (${r.status})`);
  const { voices } = (await r.json()) as { voices: { voice_id: string; name: string; category?: string }[] };
  const v = voices.find((x) => x.category === 'premade') ?? voices[0];
  if (!v) throw new Error('no voice available on this account');
  voiceIdCache = v.voice_id;
  return v.voice_id;
}

/** Starts synthesizing at once; the body is raw PCM16 mono at SPEAK_RATE. */
export function synthesize(apiKey: string, voiceId: string, text: string, signal: AbortSignal): Promise<Response> {
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=3`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
      signal,
    },
  );
}

/**
 * Splits off the complete sentences at the start of `text`. Returns them and
 * how many characters they used; the rest is an unfinished sentence.
 */
export function completeSentences(text: string): { sentences: string[]; used: number } {
  const sentences: string[] = [];
  const re = /[^.!?\n]*(?:[.!?]+(?=\s)|\n+)/g;
  let used = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index !== used) break;
    used = m.index + m[0].length;
    const s = m[0].trim();
    if (s) sentences.push(s);
  }
  return { sentences, used };
}

/** Markdown and other text that should not be read aloud. */
export function speakable(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
