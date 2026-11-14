// The call, for a page. Load it as a module from the voice service:
//   const { createCall } = await import('http://localhost:4200/widget.js');
//   const call = createCall({ conversationId, onChange: (state) => render(state) });
//   call.join(); call.setMic(true); call.setMic(false); call.leave();
//
// It has no look of its own: the page draws the call from the state it is
// given, so the call looks like the rest of the page. The microphone starts
// off: on to speak, off to send. Holding the space bar does the same.
// `mountVoice` at the end is a plain version for pages without a design.
const SERVICE = new URL('.', import.meta.url).href.replace(/\/$/, '');

let lk = null;
async function livekit() {
  lk ??= await import(`${SERVICE}/livekit-client.esm.mjs`);
  return lk;
}

/**
 * state: { phase, micOn, note }
 * phase: 'off' | 'connecting' | 'idle' | 'listening' | 'working' | 'speaking' | 'judging' | 'failed'
 * note:  what was last heard, or how an answer was judged
 */
export function createCall({ conversationId, serviceUrl = SERVICE, onChange = () => {}, onLevel = () => {} } = {}) {
  let room = null;
  let audioCtx = null;
  let raf = 0;
  const audios = [];
  const state = { phase: 'off', micOn: false, note: '' };
  const set = (patch) => { Object.assign(state, patch); onChange({ ...state }); };

  function startMeter(mediaStreamTrack) {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      onLevel(state.micOn ? Math.min(1, peak / 64) : 0);
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function setMic(on) {
    if (!room || on === state.micOn) return;
    const wasListening = state.phase === 'listening';
    // Turning the microphone off ends the turn: the service sends what it heard.
    set({ micOn: on, note: on ? '' : state.note, phase: on ? 'listening' : wasListening ? 'working' : 'idle' });
    try {
      await room.localParticipant.setMicrophoneEnabled(on);
      if (on && !audioCtx) {
        const pub = [...room.localParticipant.audioTrackPublications.values()][0];
        if (pub?.track?.mediaStreamTrack) startMeter(pub.track.mediaStreamTrack);
      }
    } catch {
      set({ micOn: false, phase: 'idle', note: 'The microphone could not be turned on. Check the browser permission.' });
    }
  }

  async function join() {
    if (room) return;
    set({ phase: 'connecting', micOn: false, note: '' });
    try {
      const r = await fetch(`${serviceUrl}/token?conversationId=${encodeURIComponent(conversationId)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `token ${r.status}`);
      const { Room, RoomEvent, Track } = await livekit();
      room = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const audio = track.attach();
        audio.autoplay = true;
        document.body.appendChild(audio);
        audios.push(audio);
      });
      room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
        if (topic !== 'voice') return;
        let m;
        try { m = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
        if (m.type === 'heard') {
          set({ note: `Heard: “${m.text}”`, phase: state.micOn ? 'listening' : 'working' });
        } else if (m.type === 'state') {
          if (m.state === 'speaking') set({ phase: 'speaking' });
          else if (m.state === 'judging') set({ phase: 'judging' });
          else if (m.state === 'working') set({ phase: 'working' });
          else if (m.state === 'listening') set({ phase: state.micOn ? 'listening' : 'idle' });
        } else if (m.type === 'verdict') {
          set({ note: `“${m.transcript ?? ''}” was judged ${m.verdict === 'unclear' ? 'unclear' : `a clear ${m.verdict}`}.` });
        }
      });
      room.on(RoomEvent.Disconnected, () => leave());
      await room.connect(body.url, body.token);
      await room.startAudio();
      // The microphone stays off until the person turns it on: in a loud room
      // an open microphone hears everyone.
      set({ phase: 'idle' });
    } catch (e) {
      room?.disconnect().catch(() => {});
      room = null;
      set({ phase: 'failed', note: 'The call could not start. Try again.' });
    }
  }

  function leave() {
    cancelAnimationFrame(raf);
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    for (const audio of audios.splice(0)) audio.remove();
    const r = room;
    room = null;
    r?.disconnect().catch(() => {});
    onLevel(0);
    set({ phase: 'off', micOn: false, note: '' });
  }

  // Hold the space bar to talk, unless the person is typing.
  const typing = (target) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  const down = (e) => { if (room && e.code === 'Space' && !e.repeat && !typing(e.target)) { e.preventDefault(); setMic(true); } };
  const up = (e) => { if (room && e.code === 'Space' && !typing(e.target)) { e.preventDefault(); setMic(false); } };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);

  return {
    join,
    setMic,
    leave,
    /** Leaves and stops listening for the space bar. */
    destroy() {
      leave();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    },
  };
}

const LABELS = {
  off: 'Not in a call',
  connecting: 'Connecting…',
  idle: 'Microphone is off',
  listening: 'Listening',
  working: 'Working on it…',
  speaking: 'Speaking',
  judging: 'Checking your answer…',
  failed: 'The call could not start',
};

/** A plain call for a page without a design of its own: three buttons and a line of text. */
export function mountVoice(element, { conversationId, serviceUrl = SERVICE } = {}) {
  element.innerHTML = '';
  const button = (text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    return b;
  };
  const join = button('Join call');
  const mic = button('Mic off');
  const leave = button('Leave');
  const line = document.createElement('span');
  line.style.marginLeft = '8px';
  element.append(join, mic, leave, line);
  let last = { phase: 'off', micOn: false, note: '' };
  const call = createCall({
    conversationId,
    serviceUrl,
    onChange: (state) => {
      last = state;
      const inCall = state.phase !== 'off' && state.phase !== 'failed';
      join.hidden = inCall;
      mic.hidden = leave.hidden = !inCall;
      mic.textContent = state.micOn ? 'Mic on' : 'Mic off';
      line.textContent = `${LABELS[state.phase] ?? state.phase}${state.note ? `. ${state.note}` : ''}`;
    },
  });
  mic.hidden = leave.hidden = true;
  join.addEventListener('click', () => call.join());
  mic.addEventListener('click', () => call.setMic(!last.micOn));
  leave.addEventListener('click', () => call.leave());
  return { join: call.join, leave: call.destroy };
}
