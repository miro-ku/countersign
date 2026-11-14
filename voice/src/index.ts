// The voice service: hands out room tokens, serves the page widget, and puts
// the agent's voice into each conversation's room.
import { config } from 'dotenv';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AccessToken } from 'livekit-server-sdk';
import { Call } from './call.ts';
import { API_BASE } from './api.ts';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '../../.env'), quiet: true });

const PORT = Number(process.env.VOICE_PORT ?? 4200);
const LK_URL = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
const LK_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
const LK_SECRET = process.env.LIVEKIT_API_SECRET ?? 'secret';
const ORIGINS = (process.env.VOICE_ORIGINS ?? 'http://localhost:5173').split(',');
const ELEVEN = process.env.ELEVENLABS_API_KEY ?? '';

const calls = new Map<string, Call>();

async function tokenFor(room: string, identity: string, name: string) {
  const t = new AccessToken(LK_KEY, LK_SECRET, { identity, name, ttl: '6h' });
  t.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  return t.toJwt();
}

function roomOf(conversationId: string) { return `conv-${conversationId}`; }

async function ensureCall(conversationId: string) {
  const existing = calls.get(conversationId);
  if (existing && !existing.closed) return;
  const call = new Call(conversationId, ELEVEN, () => calls.delete(conversationId));
  calls.set(conversationId, call);
  try {
    await call.start(LK_URL, await tokenFor(roomOf(conversationId), 'agent', 'Agent'));
  } catch (e) {
    calls.delete(conversationId);
    await call.close().catch(() => {});
    throw e;
  }
}

const files: Record<string, [string, string]> = {
  '/widget.js': [join(here, '../widget.js'), 'text/javascript'],
  '/livekit-client.esm.mjs': [join(here, '../node_modules/livekit-client/dist/livekit-client.esm.mjs'), 'text/javascript'],
  '/test.html': [join(here, '../test.html'), 'text/html'],
};

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && (ORIGINS.includes(origin) || origin === `http://localhost:${PORT}`)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    const file = files[url.pathname];
    if (file && req.method === 'GET') {
      res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
      res.end(await readFile(file[0]));
      return;
    }
    if (url.pathname === '/token') {
      const conversationId = url.searchParams.get('conversationId') ?? '';
      if (!/^[\w-]{1,64}$/.test(conversationId)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'conversationId is required' }));
        return;
      }
      if (!ELEVEN) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Voice is off: ELEVENLABS_API_KEY is not set.' }));
        return;
      }
      const room = roomOf(conversationId);
      const token = await tokenFor(room, `person-${Math.random().toString(36).slice(2, 8)}`, 'Miro');
      await ensureCall(conversationId);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ url: LK_URL, token, room }));
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, voice: !!ELEVEN, api: API_BASE, calls: [...calls.keys()] }));
      return;
    }
    res.writeHead(404).end('not found');
  } catch (e: any) {
    console.warn(`[voice] ${req.url}: ${e.message}`);
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => {
  console.log(`[voice] on :${PORT}, LiveKit ${LK_URL}, agent API ${API_BASE}${ELEVEN ? '' : ' — voice OFF: ELEVENLABS_API_KEY is not set'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await Promise.all([...calls.values()].map((c) => c.close()));
    process.exit(0);
  });
}
