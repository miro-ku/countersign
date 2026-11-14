// The `record` collection and its vector index. The database embeds `text`
// itself (Atlas automated embedding with a Voyage model), so no vector is
// stored or computed here. Safe to run again.
//
//   pnpm exec tsx server/search/setup.ts
import { pathToFileURL } from 'node:url';
import { config } from 'dotenv';
import { MongoClient, type Db } from 'mongodb';

export const RECORD = 'record';
export const RECORD_INDEX = 'record_meaning';
export const EMBED_MODEL = 'voyage-4';

export const recordValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'kind', 'agentId', 'conversationId', 'at', 'text'],
    properties: {
      _id: { bsonType: 'string' },
      kind: { enum: ['action', 'message'] },
      agentId: { bsonType: 'string' },
      conversationId: { bsonType: 'string' },
      at: { bsonType: 'date' },
      outcome: { enum: ['allowed', 'denied', 'asked', 'approved', 'declined', 'executed', 'failed', 'undone'] },
      action: { bsonType: 'string' },
      role: { enum: ['user', 'agent'] },
      provider: { bsonType: ['string', 'null'] },
      text: { bsonType: 'string' },
    },
  },
};

export const recordIndexDefinition = {
  fields: [
    { type: 'autoEmbed', modality: 'text', path: 'text', model: EMBED_MODEL },
    { type: 'filter', path: 'agentId' },
    { type: 'filter', path: 'kind' },
    { type: 'filter', path: 'outcome' },
    { type: 'filter', path: 'conversationId' },
  ],
};

/** Creates or updates the collection and the index, and waits until it can be queried. */
export async function setupSearch(db: Db, log: (s: string) => void = console.log): Promise<void> {
  const exists = (await db.listCollections({ name: RECORD }, { nameOnly: true }).toArray()).length > 0;
  if (exists) await db.command({ collMod: RECORD, validator: recordValidator, validationAction: 'error' });
  else await db.createCollection(RECORD, { validator: recordValidator, validationAction: 'error' });
  const col = db.collection(RECORD);
  await col.createIndex({ agentId: 1, at: -1 });
  log(`${exists ? 'updated' : 'created'} ${RECORD}`);

  const [current] = (await col.listSearchIndexes(RECORD_INDEX).toArray()) as any[];
  if (!current) {
    await col.createSearchIndex({ name: RECORD_INDEX, type: 'vectorSearch', definition: recordIndexDefinition } as any);
    log(`created vector index ${RECORD_INDEX}`);
  } else if (JSON.stringify(current.latestDefinition?.fields) !== JSON.stringify(recordIndexDefinition.fields)) {
    await col.updateSearchIndex(RECORD_INDEX, recordIndexDefinition);
    log(`updated vector index ${RECORD_INDEX}`);
  }
  for (let i = 0; ; i++) {
    const [ix] = (await col.listSearchIndexes(RECORD_INDEX).toArray()) as any[];
    if (ix?.queryable && ix.status === 'READY') break;
    if (ix?.status === 'FAILED') throw new Error(`vector index ${RECORD_INDEX} failed to build`);
    if (i % 6 === 0) log(`waiting for ${RECORD_INDEX} (${ix?.status ?? 'missing'})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  log(`vector index ${RECORD_INDEX} is queryable`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  config({ quiet: true });
  const uri = process.env.MONGODB_ADMIN_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_ADMIN_URI or MONGODB_URI is missing from .env');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    await setupSearch(client.db(process.env.MONGODB_DB || 'hackathon'));
  } finally {
    await client.close();
  }
}
