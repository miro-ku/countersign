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
      vad_silence_threshold_secs: '0.7',
      language_code: 'en',
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

  close() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
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
