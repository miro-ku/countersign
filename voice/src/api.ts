// The agent lives behind the server's API: messages go in, events come out.

export const API_BASE = process.env.VOICE_API_BASE ?? 'http://localhost:4100';

export async function postMessage(conversationId: string, text: string) {
  const r = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, source: 'voice' }),
  });
  if (!r.ok) throw new Error(`posting the message failed (${r.status})`);
}

export async function answerAsk(
  askId: string,
  answer: 'approve' | 'decline',
  transcript: string,
  verdict: 'yes' | 'no',
) {
  const r = await fetch(`${API_BASE}/api/asks/${askId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer, scope: 'conversation', source: 'voice', transcript, verdict }),
  });
  if (!r.ok) throw new Error(`answering the request failed (${r.status})`);
}

/** Reads the conversation's event stream until `signal` aborts; reconnects on a drop. */
export async function followEvents(conversationId: string, onEvent: (e: any) => void, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const r = await fetch(`${API_BASE}/api/conversations/${conversationId}/events`, {
        headers: { accept: 'text/event-stream' },
        signal,
      });
      if (!r.ok || !r.body) throw new Error(`event stream ${r.status}`);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (!data) continue;
          try { onEvent(JSON.parse(data)); } catch { /* not JSON: ignore */ }
        }
      }
    } catch (e: any) {
      if (signal.aborted) return;
      console.warn(`[voice] event stream for ${conversationId}: ${e.message}; retrying`);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}
