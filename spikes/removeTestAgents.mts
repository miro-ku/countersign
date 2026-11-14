import 'dotenv/config';
import { MongoClient } from 'mongodb';
const client = new MongoClient(process.env.MONGODB_ADMIN_URI || process.env.MONGODB_URI!);
await client.connect();
const db = client.db(process.env.MONGODB_DB);
const agents = await db.collection<any>('agents').find({ name: /^Smoke / }).toArray();
for (const a of agents) {
  const convs = (await db.collection<any>('conversations').find({ agentId: a._id }).toArray()).map((c) => c._id);
  for (const name of ['messages', 'executions', 'asks', 'decisions', 'ledger', 'record']) await db.collection<any>(name).deleteMany({ conversationId: { $in: convs } });
  await db.collection<any>('conversations').deleteMany({ agentId: a._id });
  await db.collection<any>('notes').deleteMany({ agentId: a._id });
  await db.collection<any>('agents').deleteOne({ _id: a._id });
}
console.log(`removed ${agents.length} test agent(s)`);
await client.close();
