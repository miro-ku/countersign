// Shows that the running system cannot rewrite its own audit trail.
//   pnpm exec tsx scripts/ledgerProof.ts
// As the app user (MONGODB_APP_URI) it appends one test entry to `ledger`, then
// tries to change or remove it four ways; Atlas refuses each one. As the admin
// user (MONGODB_ADMIN_URI) it removes its own test entry at the end.
import { config } from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';

config({ quiet: true });

const appUri = process.env.MONGODB_APP_URI;
const adminUri = process.env.MONGODB_ADMIN_URI || process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'hackathon';
if (!appUri || !adminUri) {
  console.error('MONGODB_APP_URI and MONGODB_ADMIN_URI must be set in .env');
  process.exit(1);
}

const app = new MongoClient(appUri);
const admin = new MongoClient(adminUri);
const ledger = app.db(dbName).collection<any>('ledger');

const id = new ObjectId().toHexString();
const entry = {
  _id: id,
  seq: -Date.now(), // negative: never collides with a real entry's seq
  at: new Date(),
  ownerId: 'proof',
  agentId: 'proof',
  agentVersion: 1,
  conversationId: 'proof',
  provider: 'proof',
  action: 'ledgerProof.test',
  kind: 'write' as const,
  fingerprint: 'proof',
  outcome: 'executed',
  undoable: false,
};

async function attempt(label: string, op: () => Promise<unknown>): Promise<boolean> {
  try {
    await op();
    console.log(`  ${label.padEnd(11)} ALLOWED  <- the ledger is NOT protected`);
    return false;
  } catch (err: any) {
    const why = err?.codeName ? `${err.codeName} (code ${err.code})` : String(err?.message ?? err);
    console.log(`  ${label.padEnd(11)} refused  ${why}`);
    return err?.code === 13; // Unauthorized
  }
}

async function main() {
  const [user] = new URL(appUri!.replace(/^mongodb\+srv:/, 'http:')).username.split(':');
  console.log(`Connected to Atlas as "${decodeURIComponent(user)}", the user the server runs as.\n`);

  await ledger.insertOne(entry);
  console.log(`insertOne    ok       test entry ${id} appended`);
  const before = JSON.stringify(await ledger.findOne({ _id: id }));

  console.log('\nTrying to rewrite history:');
  const results = [
    await attempt('updateOne', () => ledger.updateOne({ _id: id }, { $set: { outcome: 'denied' } })),
    await attempt('replaceOne', () => ledger.replaceOne({ _id: id }, { ...entry, outcome: 'denied' })),
    await attempt('deleteOne', () => ledger.deleteOne({ _id: id })),
    await attempt('deleteMany', () => ledger.deleteMany({})),
    await attempt('drop', () => ledger.drop()),
  ];

  const after = JSON.stringify(await ledger.findOne({ _id: id }));
  const unchanged = before === after && after !== 'null';
  console.log(`\nfindOne      ${unchanged ? 'entry is still there, byte for byte unchanged' : 'ENTRY CHANGED OR MISSING'}`);

  await admin.db(dbName).collection<any>('ledger').deleteOne({ _id: id });
  console.log('cleanup      test entry removed with the admin user (not the app user)');

  const ok = unchanged && results.every(Boolean);
  console.log(`\n${ok ? 'PASS: the app user can append to the ledger and read it, and nothing else.' : 'FAIL'}`);
  return ok;
}

main()
  .then((ok) => process.exitCode = ok ? 0 : 1)
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => Promise.all([app.close(), admin.close()]));
