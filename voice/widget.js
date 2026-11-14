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
  box.style.cssText = 'display:flex;align-items:center;gap:8px;font:13px system-ui,sans-serif;min-width:0';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Join call';
  button.style.cssText = 'padding:4px 10px;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer;white-space:nowrap';
  const meter = document.createElement('div');
  meter.title = 'Microphone level';
  meter.style.cssText = 'width:60px;height:6px;border-radius:3px;background:#ddd;overflow:hidden;flex:none';
  const bar = document.createElement('div');
  bar.style.cssText = 'height:100%;width:0;background:#2a9d4b;transition:width 60ms linear';
  meter.appendChild(bar);
  const status = document.createElement('span');
  status.style.cssText = 'color:#666;white-space:nowrap';
  const line = document.createElement('span');
  line.style.cssText = 'color:#222;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0';
  box.append(button, meter, status, line);
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
      setStatus('Listening');
      button.textContent = 'Leave';
    } catch (e) {
      setStatus(`Call failed: ${e.message}`);
      cleanup();
    } finally {
      button.disabled = false;
    }
  }

  function cleanup() {
    cancelAnimationFrame(raf);
    bar.style.width = '0';
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    for (const el of audios.splice(0)) el.remove();
    const r = room;
    room = null;
    r?.disconnect().catch(() => {});
    button.textContent = 'Join call';
  }

  button.addEventListener('click', () => {
    if (room) { cleanup(); setStatus('Left'); } else join();
  });

  return { leave: cleanup };
}
