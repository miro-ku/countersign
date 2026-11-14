// The call widget. Load it as a module from the voice service:
//   const { mountVoice } = await import('http://localhost:4200/widget.js');
//   mountVoice(document.getElementById('voice-slot'), { conversationId });
//
// At rest it is one phone button in the slot. In a call it adds a bar above
// the message box: what the call is doing, what was heard, a microphone
// switch and a way to leave. The microphone starts off: turn it on to speak,
// turn it off to send. Holding the space bar does the same.
const SERVICE = new URL('.', import.meta.url).href.replace(/\/$/, '');

let lk = null;
async function livekit() {
  lk ??= await import(`${SERVICE}/livekit-client.esm.mjs`);
  return lk;
}

const icon = (path, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const PHONE = '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>';
const MIC = '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>';
const MIC_OFF = '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/>';

const el = (tag, css, html) => {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

// What the call is doing, as the person reads it.
const PHASES = {
  connecting: { label: 'Connecting…', hint: '', colour: '#a1a1aa' },
  idle: { label: 'Microphone is off', hint: 'Turn it on to speak, or hold the space bar.', colour: '#a1a1aa' },
  listening: { label: 'Listening', hint: 'Turn the microphone off to send.', colour: '#059669' },
  working: { label: 'Working on it…', hint: '', colour: '#d97706' },
  speaking: { label: 'Speaking', hint: 'Turn the microphone on to cut in.', colour: '#2563eb' },
  judging: { label: 'Checking your answer…', hint: '', colour: '#d97706' },
  failed: { label: 'The call could not start', hint: 'Leave and try again.', colour: '#dc2626' },
};

export function mountVoice(element, { conversationId, serviceUrl = SERVICE } = {}) {
  element.innerHTML = '';
  const call = el('button', 'display:flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border-radius:10px;border:1px solid #e4e4e7;background:#fff;color:#18181b;cursor:pointer;flex:none', icon(PHONE, 16));
  call.type = 'button';
  call.title = 'Start a call';
  call.setAttribute('aria-label', 'Start a call');
  element.appendChild(call);

  // The bar sits above the message box, across the chat column.
  const row = element.parentElement;
  const bar = el('div', 'display:none;align-items:center;gap:14px;margin-bottom:10px;padding:12px 14px;border:1px solid #e4e4e7;border-radius:14px;background:#fafafa;font-family:inherit');
  row?.parentElement?.insertBefore(bar, row);

  const dot = el('span', 'width:10px;height:10px;border-radius:999px;background:#a1a1aa;flex:none;transition:background 150ms, box-shadow 80ms');
  const text = el('div', 'min-width:0;flex:1');
  const label = el('div', 'font-size:14px;font-weight:600;color:#18181b;line-height:1.3');
  const hint = el('div', 'font-size:12px;color:#71717a;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
  text.append(label, hint);
  const mic = el('button', 'display:flex;align-items:center;gap:8px;height:40px;padding:0 16px;border-radius:999px;border:1px solid #e4e4e7;background:#fff;color:#18181b;font:600 13px inherit;font-family:inherit;cursor:pointer;flex:none;transition:background 120ms, color 120ms');
  mic.type = 'button';
  const leave = el('button', 'display:flex;align-items:center;justify-content:center;height:40px;padding:0 14px;border-radius:999px;border:1px solid #fecaca;background:#fff;color:#dc2626;font:600 13px inherit;font-family:inherit;cursor:pointer;flex:none', 'Leave');
  leave.type = 'button';
  bar.append(dot, text, mic, leave);

  let room = null;
  let micOn = false;
  let phase = 'idle';
  let note = '';
  let audioCtx = null;
  let raf = 0;
  const audios = [];

  function render() {
    const p = PHASES[phase] ?? PHASES.idle;
    label.textContent = p.label;
    // What was heard, or how an answer was judged, matters more than the hint.
    hint.textContent = phase === 'listening' || !note ? p.hint : note;
    dot.style.background = p.colour;
    if (phase !== 'listening') dot.style.boxShadow = 'none';
    mic.innerHTML = `${icon(micOn ? MIC : MIC_OFF)}<span>${micOn ? 'Mic on' : 'Mic off'}</span>`;
    mic.style.background = micOn ? '#059669' : '#fff';
    mic.style.color = micOn ? '#fff' : '#18181b';
    mic.style.borderColor = micOn ? '#059669' : '#e4e4e7';
    mic.title = micOn ? 'Turn the microphone off to send' : 'Turn the microphone on to speak';
    mic.setAttribute('aria-label', mic.title);
    mic.setAttribute('aria-pressed', String(micOn));
  }

  function setPhase(next) {
    phase = next;
    render();
  }

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
      // The ring around the dot grows with the voice, so it is plain the call hears it.
      if (phase === 'listening') dot.style.boxShadow = `0 0 0 ${3 + Math.round(Math.min(1, peak / 64) * 10)}px rgba(5,150,105,0.22)`;
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function setMic(on) {
    if (!room || on === micOn) return;
    const wasListening = phase === 'listening';
    micOn = on;
    if (on) note = '';
    // Turning the microphone off ends the turn: the service sends what it heard.
    setPhase(on ? 'listening' : wasListening ? 'working' : 'idle');
    try {
      await room.localParticipant.setMicrophoneEnabled(on);
      if (on && !audioCtx) {
        const pub = [...room.localParticipant.audioTrackPublications.values()][0];
        if (pub?.track?.mediaStreamTrack) startMeter(pub.track.mediaStreamTrack);
      }
    } catch (e) {
      micOn = false;
      note = 'The microphone could not be turned on. Check the browser permission.';
      setPhase('idle');
    }
  }

  async function join() {
    call.style.display = 'none';
    bar.style.display = 'flex';
    note = '';
    setPhase('connecting');
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
          note = `Heard: “${m.text}”`;
          setPhase(micOn ? 'listening' : 'working');
        } else if (m.type === 'state') {
          if (m.state === 'speaking') setPhase('speaking');
          else if (m.state === 'judging') setPhase('judging');
          else if (m.state === 'working') setPhase('working');
          else if (m.state === 'listening') setPhase(micOn ? 'listening' : 'idle');
        } else if (m.type === 'verdict') {
          note = `“${m.transcript ?? ''}” was judged ${m.verdict === 'unclear' ? 'unclear' : `a clear ${m.verdict}`}.`;
          render();
        }
      });
      room.on(RoomEvent.Disconnected, () => cleanup());
      await room.connect(body.url, body.token);
      await room.startAudio();
      // The microphone stays off until the person turns it on: in a loud room
      // an open microphone hears everyone.
      setPhase('idle');
    } catch (e) {
      room?.disconnect().catch(() => {});
      room = null;
      note = '';
      setPhase('failed');
      hint.title = e.message;
    }
  }

  function cleanup() {
    cancelAnimationFrame(raf);
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    for (const audio of audios.splice(0)) audio.remove();
    const r = room;
    room = null;
    micOn = false;
    note = '';
    r?.disconnect().catch(() => {});
    bar.style.display = 'none';
    call.style.display = 'flex';
  }

  // Hold the space bar to talk, unless the person is typing.
  const typing = (target) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  const down = (e) => { if (room && e.code === 'Space' && !e.repeat && !typing(e.target)) { e.preventDefault(); setMic(true); } };
  const up = (e) => { if (room && e.code === 'Space' && !typing(e.target)) { e.preventDefault(); setMic(false); } };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);

  call.addEventListener('click', () => join());
  mic.addEventListener('click', () => setMic(!micOn));
  leave.addEventListener('click', () => cleanup());
  render();

  return {
    join,
    leave() {
      cleanup();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      bar.remove();
    },
  };
}
