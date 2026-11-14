// Runs plain-words queries against one agent's record and prints the top matches.
//   pnpm exec tsx server/search/try.ts <agentId> "query" ["query" ...]
import { client, db } from '../db.js';
import { searchRecord } from './query.js';

const [agentId, ...queries] = process.argv.slice(2);
await client.connect();
try {
  for (const q of queries) {
    console.log(`\n## ${q}`);
    for (const h of await searchRecord(db, agentId, q, { limit: 3, minScore: 0 })) {
      console.log(`${h.score.toFixed(3)} ${h.kind.padEnd(7)} ${h.text.slice(0, 150)}`);
    }
  }
} finally {
  await client.close();
}
