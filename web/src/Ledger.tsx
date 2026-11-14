import { useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { api, cap, pretty } from './api.ts';
import { PROVIDER_LABEL, type Connection, type LedgerRow } from './types.ts';
import { capFirst, deciderWords, plainSummary } from './words.ts';

/** Green went ahead, amber waits on a person, red was stopped, grey was reversed. */
const TONE: Record<string, { dot: string; text: string }> = {
  allowed: { dot: 'bg-emerald-500', text: 'text-emerald-700' },
  approved: { dot: 'bg-emerald-500', text: 'text-emerald-700' },
  executed: { dot: 'bg-emerald-600', text: 'text-emerald-700' },
  asked: { dot: 'bg-amber-500', text: 'text-amber-700' },
  declined: { dot: 'bg-red-500', text: 'text-red-700' },
  denied: { dot: 'bg-red-600', text: 'text-red-700' },
  failed: { dot: 'bg-red-500', text: 'text-red-700' },
  undone: { dot: 'bg-zinc-400', text: 'text-zinc-500' },
};

const clock = (s: string) =>
  new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const shortClock = (s?: string) =>
  s ? new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

const reasonOf = (e: LedgerRow): string | null => {
  const r = e.result as { reason?: unknown } | null | undefined;
  return r && typeof r === 'object' && typeof r.reason === 'string' ? r.reason : null;
};

/** One step of an action's story, in a word or two. */
function stepWords(e: LedgerRow): string {
  const who = e.decidedBy ? cap(e.decidedBy.split(' (')[0]) : null;
  if (e.outcome === 'approved') return `approved by ${who ?? 'Miro'}`;
  if (e.outcome === 'declined') return `rejected by ${who ?? 'Miro'}`;
  if (e.outcome === 'undone') return 'undone';
  if (e.outcome !== 'denied') return e.outcome;
  if (e.ruleId) return 'blocked by rule';
  if (/asked and said no/i.test(reasonOf(e) ?? '')) return 'refused: rejected earlier by Miro';
  return 'refused';
}

/** Everything the ledger holds about one action in one turn: asked, answered, run, undone. */
interface Group {
  key: string;
  entries: LedgerRow[];
  last: LedgerRow;
}

function groupEntries(entries: LedgerRow[]): Group[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, Group>();
  const home = new Map<string, string>();
  for (const e of sorted) {
    const key = (e.undoOf && home.get(e.undoOf)) || `${e.executionId ?? ''}|${e.fingerprint}`;
    home.set(e._id, key);
    const g = groups.get(key);
    if (g) {
      g.entries.push(e);
      g.last = e;
    } else {
      groups.set(key, { key, entries: [e], last: e });
    }
  }
  return [...groups.values()].sort((a, b) => b.last.seq - a.last.seq);
}

/** A lookup that went through: read-only, never asked about, nothing refused. */
const isQuietLookup = (g: Group) =>
  g.entries.every((e) => e.kind === 'read' && (e.outcome === 'allowed' || e.outcome === 'executed'));

type Line = { kind: 'action'; g: Group } | { kind: 'lookups'; key: string; groups: Group[] };

/** Actions one per line; runs of plain lookups folded into one quiet line. */
function lines(groups: Group[]): Line[] {
  const out: Line[] = [];
  for (const g of groups) {
    const prev = out[out.length - 1];
    if (!isQuietLookup(g)) out.push({ kind: 'action', g });
    else if (prev?.kind === 'lookups') prev.groups.push(g);
    else out.push({ kind: 'lookups', key: g.key, groups: [g] });
  }
  return out;
}

const titleOf = (g: Group) => capFirst(plainSummary(g.entries.find((e) => e.summary)?.summary, g.last.action));

export function Ledger({ entries, connections, fail }: {
  entries: LedgerRow[]; connections: Connection[]; fail: (e: unknown) => void;
}) {
  const groups = groupEntries(entries);
  const actions = groups.filter((g) => !isQuietLookup(g)).length;
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 px-5">
        <span className="text-sm font-semibold">Ledger</span>
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {entries.length ? `${actions} ${actions === 1 ? 'action' : 'actions'} · ${entries.length} entries` : ''}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {entries.length === 0 && (
          <p className="px-5 py-2 text-sm leading-relaxed text-muted-foreground">
            Every tool call the agent makes, and every answer you give, is recorded here.
          </p>
        )}
        <ol className="px-2 pb-4">
          {lines(groups).map((line) =>
            line.kind === 'action'
              ? <ActionRow key={line.g.key} g={line.g} connections={connections} fail={fail} />
              : <Lookups key={line.key} groups={line.groups} />,
          )}
        </ol>
      </ScrollArea>
    </>
  );
}

function ActionRow({ g, connections, fail }: { g: Group; connections: Connection[]; fail: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const { last } = g;
  const tone = TONE[last.outcome] ?? TONE.undone;
  // "allowed" is only the step before "executed"; the story reads better without it.
  const story = g.entries.filter((e, i) => !(e.outcome === 'allowed' && g.entries[i + 1]));
  const ran = g.entries.find((e) => e.outcome === 'executed');
  const canUndo = !!ran?.undoable && !g.entries.some((e) => e.outcome === 'undone');
  const decided = g.entries.find((e) => e.decidedBy && (e.outcome === 'approved' || e.outcome === 'declined'));
  const ruled = g.entries.find((e) => e.ruleId);
  const reason = g.entries.map(reasonOf).find(Boolean);
  const connection = connections.find((c) => c._id === g.entries.find((e) => e.connectionId)?.connectionId);

  return (
    <li>
      <Collapsible className="ledger-arrive group rounded-md">
        <div className="flex items-start gap-3 rounded-md px-3 py-2 hover:bg-muted/60">
          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', tone.dot)} />
          <CollapsibleTrigger className="min-w-0 flex-1 text-left">
            <div className="text-[13px] font-medium leading-snug break-words">{titleOf(g)}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1 text-xs">
              {story.map((e, i) => (
                <span key={e._id} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground/60">→</span>}
                  <span className={cn('font-medium', (TONE[e.outcome] ?? TONE.undone).text)}>{stepWords(e)}</span>
                </span>
              ))}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <span className="tabular-nums">{clock(last.at)}</span>
              <span>· {PROVIDER_LABEL[last.provider] ?? last.provider}</span>
              <ChevronRightIcon className="size-3 opacity-0 transition group-hover:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
            </div>
          </CollapsibleTrigger>
          {canUndo && ran && (
            <button
              disabled={busy}
              className="shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
              onClick={async () => {
                setBusy(true);
                try { await api.undo(ran._id); } catch (err) { fail(err); } finally { setBusy(false); }
              }}
            >
              Undo
            </button>
          )}
        </div>
        <CollapsibleContent>
          <dl className="mx-3 mb-2 ml-8 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md bg-muted/50 p-3 text-xs">
            <dt className="text-muted-foreground">For</dt>
            <dd>{cap(last.ownerId)}, by this agent at version {last.agentVersion}</dd>
            <dt className="text-muted-foreground">Engine</dt>
            <dd>{PROVIDER_LABEL[last.provider] ?? last.provider}{last.model ? ` (${last.model})` : ''}</dd>
            {ruled && (
              <>
                <dt className="text-muted-foreground">Rule</dt>
                <dd>{ruled.ruleId}{ruled.outcome === 'denied' && reason ? `: ${reason}` : ''}</dd>
              </>
            )}
            {decided && (
              <>
                <dt className="text-muted-foreground">Decided</dt>
                <dd>{deciderWords(decided.decidedBy)}</dd>
              </>
            )}
            {!ruled?.ruleId && !decided && reason && (
              <>
                <dt className="text-muted-foreground">Reason</dt>
                <dd>{reason}</dd>
              </>
            )}
            {connection && (
              <>
                <dt className="text-muted-foreground">Access</dt>
                <dd>
                  {cap(connection.toolkit)}, connected by {cap(connection.ownerId || last.ownerId)}
                  {connection.connectedAt ? ` at ${shortClock(connection.connectedAt)}` : ''}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Steps</dt>
            <dd className="space-y-0.5">
              {g.entries.map((e) => (
                <div key={e._id} className="flex gap-2">
                  <span className="tabular-nums text-muted-foreground">{clock(e.at)}</span>
                  <span>{e.outcome === 'allowed' ? 'allowed by rule' : stepWords(e)}</span>
                </div>
              ))}
            </dd>
            <dt className="text-muted-foreground">Action</dt>
            <dd className="font-mono break-all">{last.action}</dd>
            <dt className="text-muted-foreground">Details</dt>
            <dd><pre className="max-h-32 overflow-auto font-mono whitespace-pre-wrap break-all">{pretty(last.args)}</pre></dd>
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** Reads the agent made on the way: allowed by rule, recorded, and not the story. */
function Lookups({ groups }: { groups: Group[] }) {
  const last = groups[0].last;
  return (
    <li>
      <Collapsible className="group rounded-md">
        <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60">
          <span className="size-2 shrink-0 rounded-full border border-emerald-500" />
          <span>{groups.length === 1 ? '1 lookup' : `${groups.length} lookups`}, allowed by rule</span>
          <span className="tabular-nums">· {clock(last.at)}</span>
          <ChevronRightIcon className="size-3 transition group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mb-1 ml-8 space-y-0.5 text-xs text-muted-foreground">
            {groups.map((g) => (
              <li key={g.key} className="flex gap-2">
                <span className="tabular-nums">{clock(g.last.at)}</span>
                <span className="min-w-0 break-words">{titleOf(g)} · {PROVIDER_LABEL[g.last.provider] ?? g.last.provider}</span>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
