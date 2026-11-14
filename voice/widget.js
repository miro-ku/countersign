// The call widget. Load it as a module from the voice service:
//   const { mountVoice } = await import('http://localhost:4200/widget.js');
//   mountVoice(document.getElementById('voice-slot'), { conversationId });
const SERVICE = new URL('.', import.meta.url).href.replace(/\/$/, '');

let lk = null;
async function livekit() {
  lk ??= await import(`${SERVICE}/livekit-client.esm.mjs`);
  return lk;
}

const STATES = { listening: 'Listening', speaking: 'Speaking', judging: 'Checking your answer…' };

export function mountVoice(element, { conversationId, serviceUrl = SERVICE } = {}) {
  element.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;align-items:center;gap:8px;font:13px inherit;font-family:inherit;min-width:0';
  const button = document.createElement('button');
  button.type = 'button';
  const PHONE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
  // An icon only: plain at rest, red while a call is on.
  function showButton(inCall) {
    button.innerHTML = PHONE;
    button.title = inCall ? 'Leave call' : 'Join call';
    button.setAttribute('aria-label', button.title);
    button.style.background = inCall ? '#dc2626' : '#fff';
    button.style.color = inCall ? '#fff' : '#18181b';
    button.style.borderColor = inCall ? '#dc2626' : '#e4e4e7';
  }
  button.style.cssText = 'display:flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border-radius:10px;border:1px solid #e4e4e7;background:#fff;color:#18181b;cursor:pointer;flex:none';
  const meter = document.createElement('div');
  meter.title = 'Microphone level';
  // The level is only worth showing while a call is on.
  meter.style.cssText = 'display:none;width:48px;height:6px;border-radius:3px;background:#e4e4e7;overflow:hidden;flex:none';
  const bar = document.createElement('div');
  bar.style.cssText = 'height:100%;width:0;background:#059669;transition:width 60ms linear';
  meter.appendChild(bar);
  const status = document.createElement('span');
  status.style.cssText = 'color:#71717a;font-size:12px;white-space:nowrap';
  const line = document.createElement('span');
  line.style.cssText = 'color:#3f3f46;font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0';
  box.append(button, meter, status, line);
  showButton(false);
  element.appendChild(box);

  let room = null;
  let audioCtx = null;
  let raf = 0;
  const audios = [];

  function setStatus(s) { status.textContent = s; }

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
      bar.style.width = `${Math.min(100, (peak / 64) * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function join() {
    button.disabled = true;
    setStatus('Connecting…');
    try {
      const r = await fetch(`${serviceUrl}/token?conversationId=${encodeURIComponent(conversationId)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `token ${r.status}`);
      const { Room, RoomEvent, Track } = await livekit();
      room = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.autoplay = true;
        document.body.appendChild(el);
        audios.push(el);
      });
      room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
        if (topic !== 'voice') return;
        let m;
        try { m = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
        if (m.type === 'heard') line.textContent = `“${m.text}”`;
        else if (m.type === 'state') setStatus(STATES[m.state] || m.state);
        else if (m.type === 'verdict') setStatus(`Heard: ${m.verdict}`);
      });
      room.on(RoomEvent.Disconnected, () => cleanup());
      await room.connect(body.url, body.token);
      await room.startAudio();
      await room.localParticipant.setMicrophoneEnabled(true);
      const pub = [...room.localParticipant.audioTrackPublications.values()][0];
      if (pub?.track?.mediaStreamTrack) startMeter(pub.track.mediaStreamTrack);
      meter.style.display = 'block';
      setStatus('Listening');
      showButton(true);
    } catch (e) {
      setStatus('The call could not start. Try again.');
      status.title = e.message;
      cleanup();
    } finally {
      button.disabled = false;
    }
  }

  function cleanup() {
    cancelAnimationFrame(raf);
    bar.style.width = '0';
    meter.style.display = 'none';
    line.textContent = '';
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    for (const el of audios.splice(0)) el.remove();
    const r = room;
    room = null;
    r?.disconnect().catch(() => {});
    showButton(false);
  }

  button.addEventListener('click', () => {
    if (room) { cleanup(); setStatus(''); } else join();
  });

  return { leave: cleanup };
}
