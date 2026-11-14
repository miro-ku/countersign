// One live call: the agent's voice in a room for one conversation.
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { answerAsk, followEvents, openAsks, postMessage, properNouns } from './api.ts';
import { judge } from './judge.ts';
import {
  HEAR_RATE, Listener, SPEAK_RATE, completeSentences, pickVoice, speakable, synthesize, transcribeTurn,
} from './speech.ts';

const FRAME = SPEAK_RATE / 50; // 20 ms

interface Utterance {
  text: string;
  messageId?: string;
  audio?: Promise<Response>;
  /** Called when the line is done playing (or dropped). */
  done?: () => void;
}

/** An approval request as it is said: no ids, money in words, a channel by its name. */
export function aloud(summary: string): string {
  return summary
    .replace(/,?\s*(charge|payment|customer|refund)\s+(ch|pi|cus|re)_[A-Za-z0-9]+/g, '')
    .replace(/\b(ch|pi|cus|re)_[A-Za-z0-9]+\b/g, '')
    .replace(/(\d+)\.00 USD/g, '$1 dollars')
    .replace(/(\d+)\.(\d\d) USD/g, '$1 dollars $2')
    .replace(/\ba (\d+) dollars /g, 'a $1 dollar ')
    .replace(/#([a-z0-9_-]+)/gi, 'the $1 channel')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BACKCHANNEL = new Set(['mm', 'mhm', 'hmm', 'uh', 'um', 'yeah', 'yep', 'ok', 'okay', 'right', 'sure', 'huh']);

interface OpenAsk { id: string; summary: string; tries: number }

export class Call {
  readonly room = new Room();
  private source = new AudioSource(SPEAK_RATE, 1);
  private listener: Listener;
  private queue: Utterance[] = [];
  private speaking: Utterance | null = null;
  private playing = false;
  private cut = new AbortController();
  private stop = new AbortController();
  private voiceId = '';
  /** Per agent message: how much of its text has been queued, and whether it was cut off. */
  private replies = new Map<string, { used: number; hushed: boolean; finished: boolean }>();
  private asks: OpenAsk[] = [];
  private waiting: ReturnType<typeof setTimeout> | null = null;
  private turnAudio: Buffer[] = [];
  private liveText: string[] = [];
  private inTurn = false;
  /** The microphone switch has been used in this call. */
  private switched = false;
  /** Live lines are being kept for the turn that is open or just closing. */
  private collecting = false;
  private handledAsks = new Set<string>();
  private judging = false;
  private joinedAt = Date.now();
  private leaveTimer: NodeJS.Timeout | null = null;
  closed = false;

  constructor(
    readonly conversationId: string,
    private apiKey: string,
    private onClosed: () => void,
  ) {
    this.listener = new Listener(apiKey, {
      partial: (t) => this.onPartial(t),
      final: (t) => this.onLive(t),
      error: (m) => console.warn(`[voice] listener: ${m}`),
    });
  }

  get echo() { return this.conversationId === 'echo'; }

  async start(url: string, token: string) {
    this.voiceId = await pickVoice(this.apiKey);
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
      if (track.kind === TrackKind.KIND_AUDIO) void this.hear(track, p);
    });
    // A muted microphone sends no audio at all, so the end of the turn is told to the listener.
    this.room.on(RoomEvent.TrackMuted, () => void this.endTurn());
    this.room.on(RoomEvent.TrackUnmuted, () => this.beginTurn());
    this.room.on(RoomEvent.ParticipantConnected, () => this.cancelLeave());
    this.room.on(RoomEvent.ParticipantDisconnected, () => this.maybeLeave());
    this.room.on(RoomEvent.Disconnected, () => void this.close());
    await this.room.connect(url, token, { autoSubscribe: true, dynacast: false });
    const track = LocalAudioTrack.createAudioTrack('agent-voice', this.source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(track, opts);
    console.log(`[voice] in room ${this.conversationId}${this.echo ? ' (echo mode)' : ''}`);
    if (!this.echo) {
      // Requests already waiting when the stream (re)connects are asked about too.
      const refresh = () =>
        openAsks(this.conversationId).then((asks) => asks.forEach((a) => this.onAsk(a))).catch(() => {});
      void followEvents(this.conversationId, (e) => this.onEvent(e), this.stop.signal, refresh);
    }
    this.maybeLeave();
  }

  // ── hearing ────────────────────────────────────────────────────

  private async hear(track: RemoteTrack, p: RemoteParticipant) {
    console.log(`[voice] hearing ${p.identity}`);
    const stream = new AudioStream(track, HEAR_RATE, 1);
    let batch: Buffer[] = [];
    let n = 0;
    for await (const frame of stream as any as AsyncIterable<AudioFrame>) {
      if (this.closed) break;
      const b = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      batch.push(Buffer.from(b));
      n += frame.samplesPerChannel;
      if (n >= HEAR_RATE / 10) {
        const chunk = Buffer.concat(batch);
        if (process.env.VOICE_DEBUG) {
          let peak = 0;
          for (let i = 0; i < chunk.length; i += 2) peak = Math.max(peak, Math.abs(chunk.readInt16LE(i)));
          if (peak > 500) console.log(`[voice] level ${p.identity} ${peak}`);
        }
        this.listener.push(chunk);
        // Kept for the whole turn, to be heard again when the microphone goes off.
        if (this.turnAudio.length < 60 * 10) this.turnAudio.push(chunk);
        batch = [];
        n = 0;
      }
    }
  }

  /** The microphone came on: a turn starts, and its audio and live transcript are collected. */
  private beginTurn() {
    this.turnAudio = [];
    this.liveText = [];
    this.inTurn = true;
    this.switched = true;
    this.collecting = true;
    if (this.playing) this.bargeIn();
  }

  /**
   * The microphone went off: the turn is over. Its audio is heard once more as
   * a whole, which gets names right that the live transcript misses; the live
   * transcript is what we fall back on.
   */
  private async endTurn() {
    if (!this.inTurn) return this.listener.endTurn();
    this.inTurn = false;
    const audio = Buffer.concat(this.turnAudio);
    this.turnAudio = [];
    this.listener.endTurn();
    let text = '';
    if (audio.length >= HEAR_RATE * 2 * 0.3) {
      try {
        const heard = await transcribeTurn(this.apiKey, audio, await this.keyterms());
        text = heard.text;
        console.log(`[voice] turn heard again in ${heard.ms} ms${heard.isolated ? ', noise taken out' : ''}`);
      } catch (e: any) {
        console.warn(`[voice] ${e.message}`);
      }
    }
    // The live lines may still be arriving; give the last one a moment.
    if (!text) {
      await new Promise((r) => setTimeout(r, 1200));
      text = this.liveText.join(' ').trim();
    }
    this.liveText = [];
    this.collecting = false;
    if (text) await this.onFinal(text);
    else this.tell({ type: 'state', state: 'listening' });
  }

  /** Names worth listening for: given for the demo, and the ones already said in this conversation. */
  private async keyterms(): Promise<string[]> {
    const given = (process.env.VOICE_KEYTERMS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const seen = await properNouns(this.conversationId).catch(() => []);
    return [...new Set([...given, ...seen])];
  }

  /** A line of the live transcript. During a turn it is only kept; the turn's end decides. */
  private onLive(text: string) {
    // Once the microphone switch is in use, the turn's end decides what was
    // said. A live line that arrives late must not be sent as a second message.
    if (this.switched) {
      if (!this.collecting) return;
      this.liveText.push(text);
      if (this.inTurn) this.tell({ type: 'heard', text: this.liveText.join(' ') });
      return;
    }
    void this.onFinal(text);
  }

  private onPartial(text: string) {
    // A word over the agent's voice is a cut-in: it stops talking.
    // An "mm-hmm" while it talks is listening, not a cut-in.
    const words = text.toLowerCase().match(/[a-z']{2,}/g) ?? [];
    const real = words.filter((w) => !BACKCHANNEL.has(w));
    if (this.playing && (real.length >= 1 || words.length >= 3)) this.bargeIn();
  }

  private async onFinal(text: string) {
    console.log(`[voice] heard: ${text}`);
    this.tell({ type: 'heard', text });
    if (this.playing) this.bargeIn();
    if (this.echo) { this.say(text); return; }
    const ask = this.asks[0];
    if (ask) return this.judgeAnswer(ask, text);
    if (this.judging) return;
    try {
      await postMessage(this.conversationId, text);
      this.tell({ type: 'state', state: 'working' });
    } catch (e: any) {
      console.warn(`[voice] ${e.message}`);
      this.say('Sorry, I could not reach the agent.');
    }
  }

  // ── approvals ──────────────────────────────────────────────────

  private askAloud(ask: OpenAsk) {
    this.quiet();
    this.say(`I need your approval to ${aloud(ask.summary)}. Do you approve?`);
  }

  private async judgeAnswer(ask: OpenAsk, transcript: string) {
    if (this.judging) return;
    this.judging = true;
    this.tell({ type: 'state', state: 'judging' });
    let verdict: 'yes' | 'no' | 'unclear' = 'unclear';
    try { verdict = await judge(ask.summary, transcript); } catch { verdict = 'unclear'; }
    this.judging = false;
    console.log(`[voice] judge: "${transcript}" → ${verdict}`);
    this.tell({ type: 'verdict', verdict, transcript });
    if (this.asks[0] !== ask) return; // answered elsewhere meanwhile
    if (verdict === 'unclear') {
      ask.tries++;
      if (ask.tries < 2) {
        this.say(`I did not catch a clear yes or no. Should I ${aloud(ask.summary)}?`);
      } else {
        this.asks.shift();
        this.say('I still did not catch a clear yes or no, so I will leave it open. You can answer with the button on the page.');
        this.next();
      }
      return;
    }
    this.asks.shift();
    try {
      await answerAsk(ask.id, verdict === 'yes' ? 'approve' : 'decline', transcript, verdict);
      this.say(verdict === 'yes' ? 'Approved.' : 'Okay, declined.');
    } catch (e: any) {
      console.warn(`[voice] ${e.message}`);
      this.say('I could not record that answer. Please use the button on the page.');
    }
    this.next();
  }

  private next() {
    const ask = this.asks[0];
    if (ask) this.askAloud(ask);
  }

  // ── the agent's side ───────────────────────────────────────────

  private onEvent(e: any) {
    if (e?.type === 'message') this.onMessage(e.message);
    else if (e?.type === 'ask') this.onAsk(e.ask);
    else if (e?.type === 'execution') this.onTurn(e.execution);
  }

  /** A turn that works in silence gets one short line, so the person knows it heard them. */
  private onTurn(x: any) {
    if (!x) return;
    if (x.status !== 'running') return this.quiet();
    if (this.waiting || this.playing || this.asks.length) return;
    this.waiting = setTimeout(() => {
      this.waiting = null;
      if (!this.playing && !this.asks.length && !this.closed) this.say('One moment, I am on it.');
    }, 3500);
  }

  private quiet() {
    if (this.waiting) clearTimeout(this.waiting);
    this.waiting = null;
  }

  private onMessage(m: any) {
    if (!m || m.role !== 'agent') return;
    const id = String(m._id);
    let r = this.replies.get(id);
    if (!r) {
      // Only replies written while the call is on are spoken.
      const at = m.at ? new Date(m.at).getTime() : Date.now();
      if (at < this.joinedAt - 2000) return;
      r = { used: 0, hushed: false, finished: false };
      this.replies.set(id, r);
    }
    if (r.hushed || r.finished) return;
    if (m.text || (m.steps ?? []).some((st: any) => st.text)) this.quiet();
    const text: string =
      typeof m.text === 'string' && m.text
        ? m.text
        : (m.steps ?? []).map((s: any) => s.text ?? '').join('');
    const rest = text.slice(r.used);
    if (m.generating === false) {
      r.finished = true;
      r.used = text.length;
      const s = speakable(rest);
      if (s) this.say(s, id);
      return;
    }
    const { sentences, used } = completeSentences(rest);
    r.used += used;
    for (const s of sentences) {
      const t = speakable(s);
      if (t) this.say(t, id);
    }
  }

  private onAsk(a: any) {
    if (!a) return;
    const id = String(a._id);
    if (a.status !== 'open') {
      // Answered on the page, or closed: stop asking about it.
      const i = this.asks.findIndex((x) => x.id === id);
      if (i >= 0) {
        this.asks.splice(i, 1);
        if (i === 0) this.next();
      }
      this.handledAsks.add(id);
      return;
    }
    if (this.handledAsks.has(id)) return;
    this.handledAsks.add(id);
    const ask = { id, summary: String(a.summary ?? a.action ?? 'go ahead'), tries: 0 };
    this.asks.push(ask);
    if (this.asks.length === 1) this.askAloud(ask);
  }

  // ── speaking ───────────────────────────────────────────────────

  say(text: string, messageId?: string): Promise<void> {
    return new Promise((done) => {
      const u: Utterance = { text, messageId, done };
      // Start synthesis now so the next line is ready when this one ends.
      u.audio = synthesize(this.apiKey, this.voiceId, text, this.cut.signal);
      u.audio.catch(() => {});
      this.queue.push(u);
      if (!this.playing) void this.play();
    });
  }

  private async play() {
    this.playing = true;
    this.tell({ type: 'state', state: 'speaking' });
    while (this.queue.length && !this.closed) {
      const u = this.queue.shift()!;
      this.speaking = u;
      const signal = this.cut.signal;
      try {
        const res = await u.audio!;
        if (!res.ok || !res.body) throw new Error(`speech failed (${res.status})`);
        let carry = Buffer.alloc(0);
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          if (signal.aborted) break;
          carry = Buffer.concat([carry, Buffer.from(chunk)]);
          while (carry.length >= FRAME * 2 && !signal.aborted) {
            const pcm = new Int16Array(FRAME);
            for (let i = 0; i < FRAME; i++) pcm[i] = carry.readInt16LE(i * 2);
            carry = carry.subarray(FRAME * 2);
            await this.source.captureFrame(new AudioFrame(pcm, SPEAK_RATE, 1, FRAME));
          }
        }
        if (!signal.aborted) await this.source.waitForPlayout();
      } catch (e: any) {
        if (!signal.aborted) console.warn(`[voice] ${e.message}`);
      }
      this.speaking = null;
      u.done?.();
    }
    this.playing = false;
    this.tell({ type: 'state', state: 'listening' });
  }

  private bargeIn() {
    console.log('[voice] cut in: stopping speech');
    const ids = new Set([this.speaking?.messageId, ...this.queue.map((u) => u.messageId)]);
    for (const id of ids) {
      const r = id && this.replies.get(id);
      if (r) r.hushed = true;
    }
    this.cut.abort();
    this.cut = new AbortController();
    for (const u of this.queue.splice(0)) u.done?.();
    this.source.clearQueue();
  }

  // ── room ───────────────────────────────────────────────────────

  private tell(msg: object) {
    const p = this.room.localParticipant;
    if (!p || this.closed) return;
    p.publishData(new TextEncoder().encode(JSON.stringify(msg)), { reliable: true, topic: 'voice' })
      .catch(() => {});
  }

  private cancelLeave() {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }

  private maybeLeave() {
    if (this.room.remoteParticipants.size > 0) return this.cancelLeave();
    if (this.leaveTimer) return;
    this.leaveTimer = setTimeout(() => {
      if (this.room.remoteParticipants.size === 0) void this.close();
    }, 30_000);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelLeave();
    this.stop.abort();
    this.cut.abort();
    this.listener.close();
    try { await this.room.disconnect(); } catch {}
    console.log(`[voice] left room ${this.conversationId}`);
    this.onClosed();
  }
}
