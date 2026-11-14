// Creates the collections with their validators and indexes, and the default
// rules. Safe to run again: it updates what exists.
import { client, db } from './db.js';

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
      version: int, defaultProvider: { enum: ['claude-code', 'codex'] }, createdAt: date,
    },
  ),
  connections: schema(['_id', 'agentId', 'ownerId', 'toolkit', 'status'], {
    agentId: str, ownerId: str, toolkit: str,
    status: { enum: ['pending', 'active', 'revoked'] },
  }),
  rules: schema(['_id', 'agentId', 'match', 'effect'], {
    _id: str, agentId: strOrNull,
    match: { bsonType: 'object', properties: { action: str, kind } },
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
    { _id: 'default-read', agentId: null, match: { kind: 'read' as const }, effect: 'allow' as const, reason: 'Reading is allowed by default.' },
    { _id: 'default-write', agentId: null, match: { kind: 'write' as const }, effect: 'ask' as const, reason: 'Changes are asked about by default.' },
  ];
  for (const rule of defaults) {
    await db.collection('rules').replaceOne({ _id: rule._id as any }, rule, { upsert: true });
  }
  console.log('default rules in place: read → allow, write → ask');
  await client.close();
}

main().catch(async (err) => {
  console.error(err);
  await client.close();
  process.exit(1);
});
