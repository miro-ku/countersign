// Talking to the server: plain fetch helpers and one hook that keeps a
// conversation live (snapshot first, then the event stream).
import { useEffect, useRef, useState } from 'react';
import type {
  Agent, Ask, Connection, Conversation, Execution, LedgerRow, Message, Provider, Rule, StreamEvent,
} from './types.ts';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `${res.status} ${res.statusText}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data as T;
}

/** The server may wrap a document (`{ agent }`) or send it bare. */
function unwrap<T>(data: any, key: string): T {
  return data && typeof data === 'object' && key in data ? data[key] : data;
}

export const api = {
  listAgents: async () => {
    const d = await call<any>('GET', '/api/agents');
    return (Array.isArray(d) ? d : d?.agents ?? []) as Agent[];
  },
  getAgent: async (id: string) => unwrap<Agent>(await call('GET', `/api/agents/${id}`), 'agent'),
  createAgent: async (body: { name: string; instructions: string; defaultProvider: Provider }) =>
    unwrap<Agent>(await call('POST', '/api/agents', body), 'agent'),
  listConnections: async (agentId: string) => {
    const d = await call<any>('GET', `/api/agents/${agentId}/connections`);
    return (Array.isArray(d) ? d : d?.connections ?? []) as Connection[];
  },
  connect: (agentId: string, toolkit: string) =>
    call<{ redirectUrl: string }>('POST', `/api/agents/${agentId}/connections`, { toolkit }),
  disconnect: (connectionId: string) => call('DELETE', `/api/connections/${connectionId}`),
  listConversations: async (agentId: string) => {
    const d = await call<any>('GET', `/api/conversations?agentId=${agentId}`);
    return (Array.isArray(d) ? d : d?.conversations ?? []) as Conversation[];
  },
  latestConversation: async (agentId: string) => (await api.listConversations(agentId))[0] ?? null,
  /** The rules that apply to an agent, in order. Falls back to the full list while the filtered one is missing. */
  addRule: (agentId: string, text: string) => call<Rule>('POST', `/api/agents/${agentId}/rules`, { text }),
  removeRule: (id: string) => call('DELETE', `/api/rules/${id}`),
  rules: async (agentId: string): Promise<Rule[]> => {
    try {
      const d = await call<any>('GET', `/api/rules?agentId=${agentId}`);
      if (Array.isArray(d)) return d;
    } catch { /* fall through */ }
    const all = await call<Rule[]>('GET', '/api/rules');
    return all.filter((r) => r.agentId === agentId || r.agentId == null);
  },
  toolkits: () => call<{ id: string; name: string; auth: 'oauth' | 'api_key'; logo: string }[]>('GET', '/api/toolkits'),
  createConversation: async (agentId: string) =>
    unwrap<Conversation>(await call('POST', '/api/conversations', { agentId }), 'conversation'),
  getConversation: (id: string) => call<any>('GET', `/api/conversations/${id}`),
  send: (id: string, text: string, source: 'text' | 'voice' = 'text') =>
    call('POST', `/api/conversations/${id}/messages`, { text, source }),
  /** Speech to text for a short recording. */
  transcribe: async (audio: Blob): Promise<string> => {
    const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': audio.type || 'audio/webm' }, body: audio });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? 'Speech to text failed.');
    return String(body.text ?? '');
  },
  switchProvider: (id: string, provider: Provider) =>
    call('POST', `/api/conversations/${id}/provider`, { provider }),
  stop: (id: string) => call('POST', `/api/conversations/${id}/stop`),
  answer: (askId: string, answer: 'approve' | 'decline', scope: 'once' | 'conversation') =>
    call('POST', `/api/asks/${askId}/answer`, { answer, scope, source: 'button' }),
  undo: (ledgerId: string) => call('POST', `/api/ledger/${ledgerId}/undo`),
};

type ById<T> = Record<string, T>;

export interface Live {
  conversation: Conversation | null;
  messages: ById<Message>;
  asks: ById<Ask>;
  ledger: ById<LedgerRow>;
  executions: ById<Execution>;
  connections: ById<Connection>;
  online: boolean;
  /** The conversation's messages have been read at least once. */
  loaded: boolean;
}

const empty: Live = {
  conversation: null, messages: {}, asks: {}, ledger: {}, executions: {}, connections: {}, online: false, loaded: false,
};

const byId = <T extends { _id: string }>(list: T[] | undefined): ById<T> =>
  Object.fromEntries((list ?? []).map((d) => [d._id, d]));

/** Keeps one conversation's documents in local state, upserted by `_id`. */
export function useConversation(conversationId: string | null, agentId: string | null): Live {
  const [live, setLive] = useState<Live>(empty);
  const current = useRef(conversationId);
  current.current = conversationId;

  useEffect(() => {
    setLive(empty);
    if (!conversationId) return;
    let closed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const loadSnapshot = async () => {
      const snap = await api.getConversation(conversationId);
      const conns = agentId ? await api.listConnections(agentId).catch(() => []) : [];
      if (closed) return;
      setLive((prev) => ({
        ...prev,
        conversation: snap.conversation ?? null,
        messages: byId(snap.messages),
        // The snapshot carries asks of every status, so answered ones keep their summary.
        asks: { ...prev.asks, ...byId(snap.asks) },
        ledger: { ...prev.ledger, ...byId(snap.ledger ?? snap.ledgerEntries ?? snap.entries) },
        executions: { ...prev.executions, ...byId(snap.executions) },
        connections: byId(conns),
        loaded: true,
      }));
    };

    const apply = (ev: StreamEvent) => {
      setLive((prev) => {
        switch (ev.type) {
          case 'message': return { ...prev, messages: { ...prev.messages, [ev.message._id]: ev.message } };
          case 'ask': return { ...prev, asks: { ...prev.asks, [ev.ask._id]: ev.ask } };
          case 'ledger': return { ...prev, ledger: { ...prev.ledger, [ev.entry._id]: ev.entry } };
          case 'conversation': return { ...prev, conversation: ev.conversation };
          case 'execution': return { ...prev, executions: { ...prev.executions, [ev.execution._id]: ev.execution } };
          case 'connection': return { ...prev, connections: { ...prev.connections, [ev.connection._id]: ev.connection } };
          default: return prev;
        }
      });
    };

    const open = () => {
      if (closed) return;
      source = new EventSource(`/api/conversations/${conversationId}/events`);
      source.onopen = () => {
        setLive((p) => ({ ...p, online: true }));
        // Anything that happened while we were away comes with the snapshot.
        loadSnapshot().catch(() => {});
      };
      source.onmessage = (e) => {
        try { apply(JSON.parse(e.data)); } catch { /* ignore a malformed event */ }
      };
      // Some servers name their events; listen for those too.
      for (const t of ['ask', 'ledger', 'conversation', 'execution', 'connection']) {
        source.addEventListener(t, (e) => {
          try {
            const data = JSON.parse((e as MessageEvent).data);
            apply(data.type ? data : ({ type: t, [t === 'ledger' ? 'entry' : t]: data } as StreamEvent));
          } catch { /* ignore */ }
        });
      }
      source.onerror = () => {
        source?.close();
        setLive((p) => ({ ...p, online: false }));
        clearTimeout(retry);
        retry = setTimeout(open, 1500);
      };
    };

    loadSnapshot().catch(() => {});
    open();
    return () => { closed = true; clearTimeout(retry); source?.close(); };
  }, [conversationId, agentId]);

  return live;
}

export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function pretty(v: unknown): string {
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2) ?? '';
}
