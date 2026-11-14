// A post to a channel id is summarized with the channel's name.
import { config } from 'dotenv';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createComposioSource } from '../../server/integrations/index.js';
config({ quiet: true });

const client = new MongoClient(process.env.MONGODB_URI!);
const db = client.db(process.env.MONGODB_DB || 'hackathon');
try {
  const agent = await db.collection<any>('agents').findOne({ ownerId: 'miro', name: 'Apps test agent' });
  const source = createComposioSource(db)!;
  const input = { tools: [{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: 'C0CHQPNT13Q', markdown_text: 'The Acme refund is approved.' } }] };
  console.log('before tools():', source.actionsOf('COMPOSIO_MULTI_EXECUTE_TOOL', input, { agentId: agent._id })![0].summary);
  const t0 = Date.now();
  await source.tools(agent._id);
  console.log('tools() took', Date.now() - t0, 'ms');
  const [a] = source.actionsOf('COMPOSIO_MULTI_EXECUTE_TOOL', input, { agentId: agent._id })!;
  console.log('after tools():', a.summary);
  assert.equal(a.summary, "post to #demo: 'The Acme refund is approved.'");
  assert.deepEqual(a.args, input.tools[0].arguments);
  const t1 = Date.now();
  await source.tools(agent._id);
  console.log('second tools() took', Date.now() - t1, 'ms');
} finally {
  await client.close();
}
