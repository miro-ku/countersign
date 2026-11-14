// The apps track with a real connected Slack account.
//
//   npx tsx spikes/composio/live-check.ts setup
//     Makes (or finds) the agent "Apps test agent" and prints the link a person
//     opens to connect Slack to it (served by the server on 4100).
//   npx tsx spikes/composio/live-check.ts run [channel]
//     With Slack connected: lists the tools, unpacks a multi-execute call into
//     actions, lists the channels, posts a message and undoes it.
import { config } from 'dotenv';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { createComposioSource } from '../../server/integrations/index.js';
import { composioClient } from '../../server/integrations/composio.js';
import type { LedgerEntry } from '../../shared/types.js';
config({ quiet: true });

const NAME = 'Apps test agent';
const client = new MongoClient(process.env.MONGODB_URI!);
const db = client.db(process.env.MONGODB_DB || 'hackathon');
const [mode = 'run', channelArg] = process.argv.slice(2);

try {
  const agents = db.collection<any>('agents');
  let agent = await agents.findOne({ ownerId: 'miro', name: NAME });
  if (mode === 'setup') {
    if (!agent) {
      const instructions = 'A test agent for connected apps.';
      agent = {
        _id: new ObjectId().toHexString(), ownerId: 'miro', name: NAME, instructions,
        instructionsHash: createHash('sha256').update(instructions).digest('hex').slice(0, 16),
        version: 1, defaultProvider: 'claude-code', createdAt: new Date(),
      };
      await agents.insertOne(agent);
    }
    console.log(`agent ${agent._id}`);
    console.log(`open: http://localhost:4100/api/agents/${agent._id}/connect/slack`);
  } else {
    assert.ok(agent, 'run setup first');
    const agentId: string = agent._id;
    const connections = db.collection<any>('connections');
    let slack = await connections.findOne({ agentId, toolkit: 'slack', status: 'active' });
    if (!slack) {
      // Authorized while nothing listened on 4100: confirm with Composio as the callback would.
      const pending = await connections.findOne({ agentId, toolkit: 'slack', status: 'pending' }, { sort: { createdAt: -1 } });
      const account: any = pending && (await composioClient()!.connectedAccounts.get(pending.composioAccountId));
      assert.ok(account?.status === 'ACTIVE', 'Slack is not connected to the test agent yet');
      await connections.updateOne({ _id: pending._id }, { $set: { status: 'active', connectedAt: new Date() } });
      slack = await connections.findOne({ _id: pending._id });
      console.log('confirmed a connection whose callback never arrived');
    }
    const source = createComposioSource(db)!;
    const ctx = { ownerId: 'miro', agentId, conversationId: 'spike', provider: 'claude-code' as const };

    const tools = await source.tools(agentId);
    console.log('tools:', tools.map((t) => t.name));
    assert.deepEqual(tools.map((t) => t.name).sort(), ['COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'COMPOSIO_SEARCH_TOOLS']);

    const listInput = { tools: [{ tool_slug: 'SLACK_LIST_ALL_CHANNELS', arguments: { limit: 20 } }] };
    console.log('actions:', source.actionsOf('COMPOSIO_MULTI_EXECUTE_TOOL', listInput, { agentId }));
    const listed: any = await source.run('COMPOSIO_MULTI_EXECUTE_TOOL', listInput, ctx);
    const channels: any[] = listed.results[0].data?.channels ?? [];
    console.log('channels:', channels.map((c) => `#${c.name}${c.is_member ? '' : ' (not a member)'}`).join(', '));
    const target = channelArg ?? channels.find((c) => c.is_member)?.id ?? channels[0]?.id;
    assert.ok(target, 'no channel to post to');

    const postInput = { tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: target, markdown_text: `Apps track check ${new Date().toISOString()}` } }] };
    const [action] = source.actionsOf('COMPOSIO_MULTI_EXECUTE_TOOL', postInput, { agentId })!;
    console.log('post action:', action.summary, '| connection', action.connectionId, '| undoable', source.undoable(action));
    const posted: any = await source.run('COMPOSIO_MULTI_EXECUTE_TOOL', postInput, ctx);
    console.log('posted:', posted.results.map((r: any) => ({ ok: r.successful, channel: r.channel, ts: r.ts, error: r.error })));

    // The ledger entry as the gateway writes it: the whole call's result.
    const entry = { action: action.name, args: action.args, result: posted, agentId } as unknown as LedgerEntry;
    console.log('undo:', await source.undo!(entry));

    // A revoked connection's actions fail at once.
    await connections.updateOne({ _id: slack._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
    await assert.rejects(source.run('COMPOSIO_MULTI_EXECUTE_TOOL', listInput, ctx));
    console.log('after revoking in our database, run() refuses');
    await connections.updateOne({ _id: slack._id }, { $set: { status: 'active' }, $unset: { revokedAt: '' } });
    console.log('(restored the connection)');
  }
} finally {
  await client.close();
}
