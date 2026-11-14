// Creates the collections with their validators and indexes, and the default
// rules. Safe to run again: it updates what exists.
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';
import { setupSearch } from './search/index.js';
import { checkRule } from './gateway/rules.js';

config({ quiet: true });

// Setup changes validators and indexes, which the server's own user may not do:
// it runs as the admin user when MONGODB_ADMIN_URI is set.
const uri = process.env.MONGODB_ADMIN_URI || process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is missing from .env');
const client = new MongoClient(uri);
const db = client.db(process.env.MONGODB_DB || 'hackathon');

const str = { bsonType: 'string' };
const strOrNull = { bsonType: ['string', 'null'] };
const date = { bsonType: 'date' };
const dateOrNull = { bsonType: ['date', 'null'] };
const bool = { bsonType: 'bool' };
const int = { bsonType: ['int', 'long', 'double'] };
const obj = { bsonType: 'object' };
const kind = { enum: ['read', 'write'] };

function schema(required: string[], properties: Record<string, unknown>) {
  return { $jsonSchema: { bsonType: 'object', required, properties } };
}

const validators: Record<string, object> = {
  agents: schema(
    ['_id', 'ownerId', 'name', 'instructions', 'instructionsHash', 'version', 'defaultProvider', 'createdAt'],
    {
      _id: str, ownerId: str, name: str, instructions: str, instructionsHash: str,
      version: int, defaultProvider: { enum: ['claude-code', 'codex'] }, testTools: bool, createdAt: date,
    },
  ),
  connections: schema(['_id', 'agentId', 'ownerId', 'toolkit', 'status'], {
    agentId: str, ownerId: str, toolkit: str,
    status: { enum: ['pending', 'active', 'revoked'] },
  }),
  rules: schema(['_id', 'agentId', 'match', 'effect'], {
    _id: str, agentId: strOrNull,
    match: {
      bsonType: 'object',
      properties: {
        action: str, kind, actionPattern: str, argsPattern: str,
        conditions: {
          bsonType: 'array',
          items: {
            bsonType: 'object',
            required: ['field', 'op', 'value'],
            properties: { field: str, op: { enum: ['eq', 'neq', 'gte', 'lte', 'contains', 'matches'] } },
          },
        },
      },
    },
    effect: { enum: ['allow', 'ask', 'deny'] }, reason: str,
  }),
  conversations: schema(
    ['_id', 'agentId', 'ownerId', 'provider', 'providerSessions', 'stoppedNote', 'createdAt'],
    {
      _id: str, agentId: str, ownerId: str, provider: str,
      providerSessions: obj, stoppedNote: bool, createdAt: date,
    },
  ),
  messages: schema(['_id', 'conversationId', 'seq', 'role', 'text', 'source', 'generating', 'steps', 'at'], {
    _id: str, conversationId: str, seq: int, role: { enum: ['user', 'agent', 'event'] },
    text: str, source: { enum: ['text', 'voice'] }, provider: str, model: strOrNull,
    executionId: str, generating: bool, steps: { bsonType: 'array' }, at: date,
  }),
  executions: schema(['_id', 'conversationId', 'triggerMessageId', 'provider', 'status', 'startedAt'], {
    _id: str, conversationId: str, triggerMessageId: str, provider: str, model: strOrNull,
    status: { enum: ['running', 'completed', 'stopped', 'failed', 'handed_off'] },
    providerSessionId: strOrNull, startedAt: date, endedAt: dateOrNull, error: strOrNull,
  }),
  asks: schema(
    ['_id', 'conversationId', 'agentId', 'fingerprint', 'action', 'summary', 'status', 'askedByProvider', 'createdAt'],
    {
      _id: str, conversationId: str, agentId: str, executionId: strOrNull, fingerprint: str,
      action: str, summary: str, askedByProvider: str, createdAt: date,
      status: { enum: ['open', 'approved', 'declined', 'replied', 'stopped'] },
      answer: { bsonType: ['object', 'null'] },
    },
  ),
  decisions: schema(['_id', 'conversationId', 'fingerprint', 'effect', 'scope', 'askId', 'by', 'at'], {
    _id: str, conversationId: str, fingerprint: str, effect: { enum: ['approved', 'declined'] },
    scope: { enum: ['once', 'conversation'] }, askId: str, by: str, at: date, usedAt: dateOrNull,
  }),
  ledger: schema(
    ['_id', 'seq', 'at', 'ownerId', 'agentId', 'agentVersion', 'conversationId', 'provider', 'action', 'kind', 'fingerprint', 'outcome', 'undoable'],
    {
      _id: str, seq: int, at: date, ownerId: str, agentId: str, agentVersion: int,
      conversationId: str, provider: str, action: str, kind, fingerprint: str,
      outcome: { enum: ['allowed', 'denied', 'asked', 'approved', 'declined', 'executed', 'failed', 'undone'] },
      undoable: bool,
    },
  ),
  notes: schema(['_id', 'agentId', 'text', 'at'], { _id: str, agentId: str, text: str, at: date }),
  counters: schema(['_id', 'n'], { _id: str, n: int }),
};

const indexes: Record<string, Array<[Record<string, 1 | -1>, Record<string, unknown>?]>> = {
  agents: [[{ ownerId: 1, createdAt: -1 }]],
  connections: [[{ agentId: 1, status: 1 }]],
  rules: [[{ agentId: 1 }]],
  conversations: [[{ agentId: 1, createdAt: -1 }]],
  messages: [[{ conversationId: 1, seq: 1 }, { unique: true }]],
  executions: [
    [{ conversationId: 1, startedAt: -1 }],
    // One turn at a time per conversation, even across server processes.
    [{ conversationId: 1 }, { unique: true, partialFilterExpression: { status: 'running' }, name: 'one_running_turn' }],
  ],
  asks: [
    [{ conversationId: 1, fingerprint: 1 }, { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_ask_per_action' }],
    [{ conversationId: 1, status: 1 }],
  ],
  decisions: [[{ conversationId: 1, fingerprint: 1 }, { unique: true }]],
  ledger: [[{ seq: 1 }, { unique: true }], [{ conversationId: 1, seq: -1 }]],
  notes: [[{ agentId: 1, at: 1 }]],
};

async function main() {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, validator] of Object.entries(validators)) {
    if (existing.has(name)) {
      await db.command({ collMod: name, validator, validationAction: 'error' });
    } else {
      await db.createCollection(name, { validator, validationAction: 'error' });
    }
    for (const [keys, options] of indexes[name] ?? []) {
      await db.collection(name).createIndex(keys, options ?? {});
    }
    console.log(`${existing.has(name) ? 'updated' : 'created'} ${name}`);
  }

  const defaults = [
    { _id: 'default-read', agentId: null, match: { kind: 'read' as const }, effect: 'allow' as const, title: 'Anything that only reads', reason: 'Reading is allowed by default.' },
    { _id: 'default-write', agentId: null, match: { kind: 'write' as const }, effect: 'ask' as const, title: 'Anything that changes something', reason: 'Changes are asked about by default.' },
    {
      _id: 'no-card-numbers', agentId: null,
      // 13 to 19 digits, optionally separated by single spaces or dashes.
      match: { kind: 'write' as const, argsPattern: '(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])' },
      effect: 'deny' as const, title: 'Any change that contains a card number', reason: 'Card numbers are never sent anywhere.',
    },
    {
      _id: 'no-deleting-channels', agentId: null,
      match: { actionPattern: '^[A-Z]+_(ARCHIVE|DELETE)_(A_)?(PUBLIC_OR_PRIVATE_)?(CHANNEL|CONVERSATION)' },
      effect: 'deny' as const, title: 'Deleting or archiving a channel', reason: 'Channels are never deleted or archived by an agent.',
    },
    {
      _id: 'no-large-refunds', agentId: null,
      // An amount of 10000 or more in the smallest unit: 100.00 and above.
      match: { actionPattern: 'REFUND', argsPattern: '"amount":\\s*"?[1-9][0-9]{4,}' },
      effect: 'deny' as const, title: 'A refund of 100.00 or more', reason: 'Refunds of 100.00 or more are never made by an agent.',
    },
  ];
  for (const rule of defaults) checkRule(rule);
  for (const rule of defaults) {
    await db.collection('rules').replaceOne({ _id: rule._id as any }, rule, { upsert: true });
  }
  console.log('default rules in place: read → allow, write → ask, no card numbers, no deleting channels');
  // The agent's record of its own past and its vector index.
  await setupSearch(db);
  await client.close();
}

main().catch(async (err) => {
  console.error(err);
  await client.close();
  process.exit(1);
});
