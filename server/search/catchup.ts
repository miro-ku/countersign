// Records every ledger entry and message that has no search record yet.
//   pnpm exec tsx server/search/catchup.ts [--all]   (--all rewrites every sentence)
import { client, db } from '../db.js';
import { catchUp } from './worker.js';

await client.connect();
try {
  console.log(await catchUp(db, { all: process.argv.includes('--all') }));
} finally {
  await client.close();
}
