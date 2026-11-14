// Connecting an app to an agent: start, return from Composio, list, revoke.
import type { Hono } from 'hono';
import { ObjectId, type Db } from 'mongodb';
import type { Composio } from '@composio/core';
import {
  composioClient,
  composioUserId,
  connectionsOf,
  ensureAuthConfig,
  TOOLKITS,
  type ConnectionRecord,
} from './composio.js';

const OWNER_ID = 'miro';
const SERVER_URL = () => process.env.SERVER_URL || 'http://localhost:4100';
const WEB_URL = () => process.env.WEB_URL || 'http://localhost:5173';

/** How long the return from Composio waits for the account to turn active. */
const CONFIRM_MS = 8000;

function publicView(c: ConnectionRecord) {
  return {
    _id: c._id,
    agentId: c.agentId,
    toolkit: c.toolkit,
    status: c.status,
    composioAccountId: c.composioAccountId ?? null,
    connectedAt: c.connectedAt ?? null,
    revokedAt: c.revokedAt ?? null,
    createdAt: c.createdAt ?? null,
  };
}

async function accountStatus(composio: Composio, accountId: string): Promise<string> {
  const account: any = await composio.connectedAccounts.get(accountId);
  return String(account?.status ?? 'UNKNOWN').toUpperCase();
}

/** Polls Composio until the account is active or clearly not going to be. */
async function waitActive(composio: Composio, accountId: string): Promise<string> {
  const until = Date.now() + CONFIRM_MS;
  let status = await accountStatus(composio, accountId);
  while (status !== 'ACTIVE' && ['INITIATED', 'INITIALIZING', 'PENDING'].includes(status) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    status = await accountStatus(composio, accountId);
  }
  return status;
}

export function registerConnectionRoutes(api: Hono, db: Db): void {
  const connections = connectionsOf(db);
  const agents = db.collection<{ _id: string }>('agents');

  api.get('/agents/:id/connections', async (c) => {
    const list = await connections.find({ agentId: c.req.param('id') }).sort({ createdAt: -1 }).toArray();
    return c.json(list.map(publicView));
  });

  /** Starts a connection; the result is the page to send the person to, or an error. */
  async function start(agentId: string, rawToolkit: unknown): Promise<{ redirectUrl: string; connectionId: string } | { error: string; status: 400 | 404 | 502 | 503 }> {
    const composio = composioClient();
    if (!composio) return { error: 'Connecting apps is off: COMPOSIO_API_KEY is not set.', status: 503 };
    const toolkit = String(rawToolkit ?? '').toLowerCase();
    if (!(TOOLKITS as readonly string[]).includes(toolkit)) {
      return { error: `toolkit must be one of ${TOOLKITS.join(', ')}`, status: 400 };
    }
    if (!(await agents.findOne({ _id: agentId }))) return { error: 'No such agent.', status: 404 };

    const authConfigId = await ensureAuthConfig(composio, toolkit);
    const id = new ObjectId().toHexString();
    const userId = composioUserId(agentId);
    const callbackUrl = `${SERVER_URL()}/api/connections/callback?connection=${id}`;
    const request = await composio.connectedAccounts.link(userId, authConfigId, { callbackUrl });
    if (!request.redirectUrl) return { error: 'Composio gave no authorization page.', status: 502 };

    await connections.insertOne({
      _id: id,
      agentId,
      ownerId: OWNER_ID,
      toolkit,
      composioUserId: userId,
      composioAccountId: request.id,
      status: 'pending',
      connectedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });
    return { redirectUrl: request.redirectUrl, connectionId: id };
  }

  api.post('/agents/:id/connections', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await start(c.req.param('id'), body.toolkit);
    return 'error' in r ? c.json({ error: r.error }, r.status) : c.json(r, 201);
  });

  // The same as a link a person can open: starts the connection and goes straight to Composio.
  api.get('/agents/:id/connect/:toolkit', async (c) => {
    const r = await start(c.req.param('id'), c.req.param('toolkit'));
    return 'error' in r ? c.json({ error: r.error }, r.status) : c.redirect(r.redirectUrl, 302);
  });

  api.get('/connections/callback', async (c) => {
    const id = c.req.query('connection') ?? '';
    const back = (params: Record<string, string>) => c.redirect(`${WEB_URL()}/?${new URLSearchParams(params)}`, 302);
    const composio = composioClient();
    const doc = await connections.findOne({ _id: id });
    if (!composio || !doc) return back({ connectError: doc?.toolkit ?? 'unknown' });
    if (doc.status === 'active') return back({ connected: doc.toolkit });
    if (doc.status === 'revoked') return back({ connectError: doc.toolkit });
    // The person declined or the provider refused: no need to ask Composio.
    if (c.req.query('status') === 'failed') return back({ connectError: doc.toolkit });

    // Composio adds the account it made; trust only one tied to this connection.
    const fromQuery = c.req.query('connected_account_id') || c.req.query('connectedAccountId');
    const accountId = doc.composioAccountId || fromQuery;
    if (!accountId) return back({ connectError: doc.toolkit });

    let status: string;
    try {
      status = await waitActive(composio, accountId);
    } catch {
      status = 'ERROR';
    }
    if (status !== 'ACTIVE') return back({ connectError: doc.toolkit });

    const now = new Date();
    const updated = await connections.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'active', composioAccountId: accountId, connectedAt: now } },
      { returnDocument: 'after' },
    );
    if (updated) {
      // One active connection per app per agent: an older one is replaced.
      const older = await connections
        .find({ agentId: doc.agentId, toolkit: doc.toolkit, status: 'active', _id: { $ne: id } })
        .toArray();
      for (const o of older) {
        await connections.updateOne({ _id: o._id, status: 'active' }, { $set: { status: 'revoked', revokedAt: now } });
        if (o.composioAccountId) composio.connectedAccounts.delete(o.composioAccountId).catch(() => {});
      }
    }
    return back({ connected: doc.toolkit });
  });

  api.delete('/connections/:id', async (c) => {
    const id = c.req.param('id');
    // Revoked in our database first: the gateway refuses its actions from here on.
    const doc = await connections.findOneAndUpdate(
      { _id: id, status: { $ne: 'revoked' } },
      { $set: { status: 'revoked', revokedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) {
      const exists = await connections.findOne({ _id: id });
      return exists ? c.json(publicView(exists)) : c.json({ error: 'No such connection.' }, 404);
    }
    const composio = composioClient();
    let removedAtComposio = false;
    if (composio && doc.composioAccountId) {
      try {
        await composio.connectedAccounts.delete(doc.composioAccountId);
        removedAtComposio = true;
      } catch {
        // Already gone or unreachable: our record is revoked either way.
      }
    }
    return c.json({ ...publicView(doc), removedAtComposio });
  });
}
