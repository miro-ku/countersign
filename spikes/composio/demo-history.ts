// Prints the latest messages in a Slack channel of the test agent's workspace.
//   npx tsx spikes/composio/demo-history.ts [channelId]
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';
import { createComposioSource } from '../../server/integrations/index.js';
config({ quiet: true });

const client = new MongoClient(process.env.MONGODB_URI!);
const db = client.db(process.env.MONGODB_DB || 'hackathon');
try {
  const agent = await db.collection<any>('agents').findOne({ ownerId: 'miro', name: 'Apps test agent' });
  const source = createComposioSource(db)!;
  const ctx = { ownerId: 'miro', agentId: agent._id, conversationId: 'spike', provider: 'claude-code' as const };
  const channel = process.argv[2] ?? 'C0CHQPNT13Q';
  const r: any = await source.run('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY', arguments: { channel, limit: 10 } }] }, ctx);
  const msgs: any[] = r.results[0].data?.messages ?? [];
  console.log(r.results[0].successful ? `${msgs.length} messages` : r.results[0].error);
  for (const m of msgs) console.log(m.ts, JSON.stringify(m.text).slice(0, 120));
} finally {
  await client.close();
}
