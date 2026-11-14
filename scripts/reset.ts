// Empties the database for a demo that starts from a blank page.
//
//   pnpm reset                       print what would be deleted, change nothing
//   pnpm reset --yes                 delete it, then restart the server
//   pnpm reset --yes --keep <id>     keep that agent (repeatable): the agent, its
//                                    connections and its own rules stay; its
//                                    conversations and their data go
//   pnpm reset --yes --no-restart    do not touch the running server
//
// Connects with MONGODB_ADMIN_URI when set (the server's own user may not delete
// ledger entries), else MONGODB_URI. The database is exactly MONGODB_DB.
// Collections are emptied, never dropped: validators and indexes stay. Default
// rules (agentId null) stay. Connections that are deleted are also removed at
// Composio, so no authorization outlives its record.
import { config } from 'dotenv';
import { spawn, execFileSync } from 'node:child_process';
import { openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, type Db, type Filter } from 'mongodb';
import { Composio } from '@composio/core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(ROOT, '.env'), quiet: true });

const PORT = Number(process.env.PORT || 4100);
const SERVER_LOG = '/tmp/mongohack-server.log';

// ── Arguments ────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const yes = argv.includes('--yes');
const restart = !argv.includes('--no-restart');
const keep: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keep') {
    const id = argv[++i];
    if (!id || id.startsWith('--')) fail('--keep needs an agent id.');
    keep.push(id);
  } else if (a.startsWith('--keep=')) {
    keep.push(a.slice('--keep='.length));
  } else if (!['--yes', '--no-restart'].includes(a)) {
    fail(`Unknown argument: ${a}`);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ── Where ────────────────────────────────────────────────────────

const usingAdmin = Boolean(process.env.MONGODB_ADMIN_URI);
const uri = process.env.MONGODB_ADMIN_URI || process.env.MONGODB_URI;
if (!uri) fail('Neither MONGODB_ADMIN_URI nor MONGODB_URI is set in .env.');
const dbName = process.env.MONGODB_DB;
if (!dbName) fail('MONGODB_DB is not set: refusing to guess which database to empty.');

/** The host part of a connection string, without credentials. */
function hostOf(u: string): string {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(u);
  return m ? m[1] : '(unreadable connection string)';
}

// ── What ─────────────────────────────────────────────────────────

/** Emptied entirely (conversations of kept agents go too). */
const CONVERSATION_DATA = ['conversations', 'messages', 'executions', 'asks', 'decisions', 'ledger', 'notes', 'counters'];
/** The searchable record of actions and messages, emptied when it exists. */
const COMPANIONS = ['record'];

interface Plan {
  name: string;
  filter: Filter<any>;
  total: number;
  toDelete: number;
}

async function plan(db: Db, existing: Set<string>): Promise<Plan[]> {
  const notKept = keep.length ? { $nin: keep } : undefined;
  const filters: Array<[string, Filter<any>]> = [
    ['agents', notKept ? { _id: notKept } : {}],
    ['connections', notKept ? { agentId: notKept } : {}],
    ['rules', notKept ? { agentId: { $ne: null, ...notKept } } : { agentId: { $ne: null } }],
    ...CONVERSATION_DATA.map((n) => [n, {}] as [string, Filter<any>]),
    ...COMPANIONS.filter((n) => existing.has(n)).map((n) => [n, {}] as [string, Filter<any>]),
  ];
  const out: Plan[] = [];
  for (const [name, filter] of filters) {
    if (!existing.has(name)) continue;
    const c = db.collection(name);
    out.push({ name, filter, total: await c.countDocuments({}), toDelete: await c.countDocuments(filter) });
  }
  return out;
}

// ── Composio ─────────────────────────────────────────────────────

async function removeAtComposio(accounts: Array<{ connectionId: string; toolkit: string; accountId: string }>) {
  if (!accounts.length) return;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    console.warn(`COMPOSIO_API_KEY is missing: ${accounts.length} Composio account(s) were NOT removed.`);
    return;
  }
  const composio = new Composio({ apiKey, allowTracking: false });
  let removed = 0, gone = 0;
  for (const a of accounts) {
    try {
      await composio.connectedAccounts.delete(a.accountId);
      removed++;
    } catch (err: any) {
      const text = String(err?.message ?? err);
      if (/not.?found|404|does not exist/i.test(text) || err?.status === 404 || err?.statusCode === 404) {
        gone++;
      } else {
        console.warn(`  could not remove the ${a.toolkit} account of connection ${a.connectionId} at Composio: ${text}`);
      }
    }
  }
  console.log(`Composio: removed ${removed}, already gone ${gone}, failed ${accounts.length - removed - gone}.`);
}

// ── The server ───────────────────────────────────────────────────

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function procInfo(pid: number): { ppid: number; command: string } | null {
  const line = sh('ps', ['-o', 'ppid=,command=', '-p', String(pid)]);
  const m = /^\s*(\d+)\s+(.*)$/.exec(line);
  return m ? { ppid: Number(m[1]), command: m[2] } : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stopServer(): Promise<void> {
  const listeners = sh('lsof', ['-nP', '-t', `-iTCP:${PORT}`, '-sTCP:LISTEN']).split('\n').filter(Boolean).map(Number);
  if (!listeners.length) {
    console.log(`No server listening on ${PORT}.`);
    return;
  }
  const targets = new Set<number>();
  for (const pid of listeners) {
    targets.add(pid);
    // Walk up through the tsx watcher and the pnpm script that started it,
    // stopping at anything else (a terminal, concurrently, launchd).
    let child = procInfo(pid);
    while (child && child.ppid > 1) {
      const parent = procInfo(child.ppid);
      if (!parent || !/tsx(\/dist\/cli\.mjs)? (watch|server\/index)|pnpm (dev|start):server/.test(parent.command)) break;
      targets.add(child.ppid);
      child = parent;
    }
  }
  console.log(`Stopping the server (pids ${[...targets].join(', ')}).`);
  // Parents first, so the watcher does not restart the child.
  for (const pid of [...targets].reverse()) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 50 && [...targets].some(alive); i++) await sleep(100);
  for (const pid of targets) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 50 && sh('lsof', ['-nP', '-t', `-iTCP:${PORT}`, '-sTCP:LISTEN']); i++) await sleep(100);
}

async function startServer(expectedAgents: number): Promise<void> {
  const out = openSync(SERVER_LOG, 'a');
  const child = spawn('pnpm', ['start:server'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  console.log(`Started pnpm start:server (pid ${child.pid}), log at ${SERVER_LOG}.`);
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/agents`);
      if (r.ok) {
        const body = await r.json();
        if (Array.isArray(body) && body.length === expectedAgents) {
          console.log(`Server is up: GET /api/agents answers ${expectedAgents === 0 ? '[]' : `${body.length} kept agent(s)`}.`);
          return;
        }
        last = `answered ${JSON.stringify(body).slice(0, 120)}`;
      } else last = `HTTP ${r.status}`;
    } catch (err: any) {
      last = err?.cause?.code ?? err?.message ?? String(err);
    }
    await sleep(500);
  }
  fail(`The server did not come back with ${expectedAgents} agent(s) within 60s (last: ${last}). See ${SERVER_LOG}.`);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`Cluster:  ${hostOf(uri!)}  (${usingAdmin ? 'MONGODB_ADMIN_URI' : 'MONGODB_URI'})`);
  console.log(`Database: ${dbName}`);
  if (!usingAdmin && yes) console.warn('MONGODB_ADMIN_URI is not set; using MONGODB_URI, which may not be allowed to delete ledger entries.');

  const client = new MongoClient(uri!);
  try {
    const db = client.db(dbName);
    if (db.databaseName !== dbName) fail(`Connected to ${db.databaseName}, not ${dbName}: refusing.`);
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    if (!existing.has('agents')) fail(`${dbName} has no agents collection: not a Proviso database, refusing.`);

    for (const id of keep) {
      const agent = await db.collection('agents').findOne({ _id: id as any });
      if (!agent) fail(`--keep ${id}: no such agent in ${dbName}.`);
      console.log(`Keeping agent ${id} (${agent.name}).`);
    }

    const steps = await plan(db, existing);
    const width = Math.max(...steps.map((s) => s.name.length));
    console.log(`\n${yes ? 'Deleting' : 'Would delete'}:`);
    for (const s of steps) {
      const kept = s.total - s.toDelete;
      console.log(`  ${s.name.padEnd(width)}  ${String(s.toDelete).padStart(5)}${kept ? `   (keeps ${kept})` : ''}`);
    }
    const untouched = [...existing].filter((n) => !steps.some((s) => s.name === n) && !n.startsWith('system.'));
    if (untouched.length) console.log(`Untouched: ${untouched.join(', ')}`);

    if (!yes) {
      console.log('\nNothing changed. Run again with --yes to delete.');
      return;
    }

    // The Composio accounts of the connections about to go.
    const connectionsStep = steps.find((s) => s.name === 'connections');
    const accounts = connectionsStep
      ? (await db.collection('connections').find(connectionsStep.filter).toArray())
          .filter((c) => c.composioAccountId)
          .map((c) => ({ connectionId: String(c._id), toolkit: String(c.toolkit), accountId: String(c.composioAccountId) }))
      : [];

    for (const s of steps) {
      const { deletedCount } = await db.collection(s.name).deleteMany(s.filter);
      if (deletedCount !== s.toDelete) console.log(`  ${s.name}: deleted ${deletedCount} (counted ${s.toDelete} a moment ago)`);
    }
    console.log('Deleted.');
    await removeAtComposio(accounts);
  } finally {
    await client.close();
  }

  if (restart) {
    await stopServer();
    await startServer(keep.length);
  } else {
    console.log('Server not restarted (--no-restart): it may still hold sessions and calls for deleted conversations.');
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
