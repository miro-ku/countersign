// Change streams on the collections the page and the gateway listen to, fanned
// out in this process. One stream per collection, however many listeners.
import { EventEmitter } from 'node:events';
import { db } from './db.js';

export type ChangeKind = 'message' | 'ask' | 'ledger' | 'conversation' | 'execution' | 'connection';

const watched: Array<[string, ChangeKind]> = [
  ['messages', 'message'],
  ['asks', 'ask'],
  ['ledger', 'ledger'],
  ['conversations', 'conversation'],
  ['executions', 'execution'],
  ['connections', 'connection'],
];

/** Emits `change` with `{ kind, doc }` for every insert, update and replace. */
export const changes = new EventEmitter();
changes.setMaxListeners(0);

/** The conversation a changed document belongs to, when it has one. */
export function conversationOf(kind: ChangeKind, doc: any): string | undefined {
  if (kind === 'conversation') return String(doc._id);
  return doc.conversationId;
}

let stopping = false;
export function stopChangeStreams(): void {
  stopping = true;
}

export function startChangeStreams(): void {
  for (const [name, kind] of watched) watch(name, kind);
}

function watch(name: string, kind: ChangeKind): void {
  const stream = db.collection(name).watch(
    [{ $match: { operationType: { $in: ['insert', 'update', 'replace'] } } }],
    { fullDocument: 'updateLookup' },
  );
  stream.on('change', (event: any) => {
    if (event.fullDocument) changes.emit('change', { kind, doc: event.fullDocument });
  });
  stream.on('error', (err) => {
    if (stopping) return;
    console.error(`change stream on ${name} failed, restarting:`, err.message);
    stream.close().catch(() => {});
    setTimeout(() => watch(name, kind), 1000);
  });
}
