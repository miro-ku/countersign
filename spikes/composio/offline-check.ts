// Checks everything that needs no connected account, against a scratch database
// and the connection routes mounted on a throwaway app on port 4111.
import { config } from 'dotenv';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { MongoClient, ObjectId } from 'mongodb';
import { createComposioSource, registerConnectionRoutes } from '../../server/integrations/index.js';
import { findSlackRef, kindOf } from '../../server/integrations/composio.js';
config({ quiet: true });

const client = new MongoClient(process.env.MONGODB_URI!);
const db = client.db('apps_track_scratch');
const agentId = new ObjectId().toHexString();
await db.collection<any>('agents').insertOne({ _id: agentId, name: 'scratch', createdAt: new Date() });

const app = new Hono();
const api = new Hono();
registerConnectionRoutes(api, db);
app.route('/api', api);
const server = serve({ fetch: app.fetch, port: 4111 });
const base = 'http://localhost:4111/api';
let ok = 0;
const pass = (what: string) => { ok++; console.log('ok  ', what); };

try {
  // ── actionsOf and kinds ──
  const source = createComposioSource(db)!;
  assert.ok(source, 'source exists with the key set');
  assert.deepEqual(await source.tools(agentId), []);
  pass('tools() is empty with no active connection');

  assert.equal(kindOf('SLACK_LIST_ALL_CHANNELS'), 'read');
  assert.equal(kindOf('GMAIL_FETCH_EMAILS'), 'read');
  assert.equal(kindOf('SLACK_SEND_MESSAGE'), 'write');
  assert.equal(kindOf('GMAIL_CREATE_LABEL'), 'write');
  assert.equal(kindOf('SLACK_DELETES_A_MESSAGE_FROM_A_CHAT'), 'write');
  assert.equal(kindOf('GMAIL_LIST_AND_TRASH'), 'write');
  pass('kind by the verb rule');

  const multi = source.actionsOf('COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [
      { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'anna@acme.com', subject: 'Refund', body: 'Done.' } },
      { tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: 'general', markdown_text: 'Refund issued for Acme' } },
      { tool_slug: 'GMAIL_CREATE_LABEL', arguments: { label_name: 'x'.repeat(300) } },
      { tool_slug: 'SLACK_LIST_ALL_CHANNELS', arguments: {} },
    ],
  })!;
  assert.equal(multi.length, 4);
  assert.equal(multi[0].summary, "send an email to anna@acme.com with the subject 'Refund'");
  assert.equal(multi[1].summary, "post to #general: 'Refund issued for Acme'");
  assert.ok(multi[2].summary.startsWith('run GMAIL_CREATE_LABEL with {'));
  assert.ok(multi[2].summary.length <= 200);
  assert.deepEqual(multi.map((a) => a.kind), ['write', 'write', 'write', 'read']);
  assert.deepEqual(multi[1].args, { channel: 'general', markdown_text: 'Refund issued for Acme' });
  for (const a of multi) console.log('      ', a.kind.padEnd(5), a.summary.slice(0, 90));
  pass('multi-execute unpacks into one action per entry, with summaries');

  assert.equal(source.actionsOf('COMPOSIO_SEARCH_TOOLS', { queries: [{ use_case: 'post to slack' }] })![0].kind, 'read');
  assert.equal(source.actionsOf('COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: ['SLACK_SEND_MESSAGE'] })![0].kind, 'read');
  for (const refused of ['COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_REMOTE_BASH_TOOL', 'COMPOSIO_MANAGE_CONNECTIONS', 'COMPOSIO_PROXY_EXECUTE', 'SLACK_SEND_MESSAGE']) {
    assert.equal(source.actionsOf(refused, {}), null, refused);
  }
  assert.equal(source.actionsOf('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'COMPOSIO_REMOTE_BASH_TOOL', arguments: {} }] }), null);
  assert.equal(source.actionsOf('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [] }), null);
  pass('lookups are reads; workbench, shell, proxy, connection tools and nested meta-tools are refused');

  assert.equal(source.undoable(multi[1]), true);
  assert.equal(source.undoable(multi[0]), false);
  const result = { results: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: multi[1].args, channel: 'C123', ts: '1.2' }] };
  assert.deepEqual(findSlackRef({ action: 'SLACK_SEND_MESSAGE', args: multi[1].args, result }), { channel: 'C123', ts: '1.2' });
  pass('only a posted Slack message is undoable, and its channel and ts are found in the ledger result');

  await assert.rejects(source.run('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'SLACK_LIST_ALL_CHANNELS', arguments: {} }] }, { ownerId: 'miro', agentId, conversationId: 'c', provider: 'claude-code' }), /no connected apps/);
  pass('run() refuses with no active connection');

  // ── routes ──
  let r = await fetch(`${base}/agents/${agentId}/connections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolkit: 'telegram' }) });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/agents/nope/connections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolkit: 'slack' }) });
  assert.equal(r.status, 404);
  pass('unknown toolkit → 400, unknown agent → 404');

  for (const toolkit of ['slack', 'gmail']) {
    r = await fetch(`${base}/agents/${agentId}/connections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolkit }) });
    const body: any = await r.json();
    assert.equal(r.status, 201, JSON.stringify(body));
    const url = new URL(body.redirectUrl);
    console.log('      ', toolkit, 'redirect host:', url.host);
    const doc: any = await db.collection('connections').findOne({ _id: body.connectionId });
    assert.equal(doc.status, 'pending');
    assert.equal(doc.composioUserId, `agent_${agentId}`);
    assert.ok(doc.composioAccountId);
  }
  pass('POST connections makes the auth config, starts a link and stores a pending connection');

  r = await fetch(`${base}/agents/${agentId}/connect/slack`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('location')!).host, 'connect.composio.dev');
  pass('GET connect/slack is a link straight to the authorization page');

  r = await fetch(`${base}/agents/${agentId}/connections`);
  const list: any[] = await r.json();
  assert.equal(list.length, 3);
  const failed = list.find((c) => c.toolkit === 'slack');
  let t1 = Date.now();
  r = await fetch(`${base}/connections/callback?connection=${failed._id}&status=failed`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), 'http://localhost:5173/?connectError=slack');
  assert.ok(Date.now() - t1 < 1500);
  pass('a declined authorization returns at once');
  await fetch(`${base}/connections/${failed._id}`, { method: 'DELETE' });
  list.shift();
  pass('GET lists the agent\'s connections');

  const pending = list.find((c) => c.toolkit === 'slack');
  const t0 = Date.now();
  r = await fetch(`${base}/connections/callback?connection=${pending._id}&status=success`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'http://localhost:5173/?connectError=slack');
  console.log('       callback on an unauthorized account answered in', Date.now() - t0, 'ms');
  pass('callback for an account nobody authorized redirects back with connectError');

  r = await fetch(`${base}/connections/${pending._id}`, { method: 'DELETE' });
  const revoked: any = await r.json();
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.revokedAt);
  r = await fetch(`${base}/connections/callback?connection=${pending._id}`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), 'http://localhost:5173/?connectError=slack');
  pass('DELETE revokes; a revoked connection cannot be completed afterwards');

  // Clean up the other pending link at Composio.
  for (const c of list) await fetch(`${base}/connections/${c._id}`, { method: 'DELETE' });
  console.log(`\n${ok} checks passed`);
} finally {
  await db.dropDatabase().catch(() => {});
  await client.close();
  server.close();
}
