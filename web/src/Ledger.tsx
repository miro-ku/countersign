import { useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { api, cap, pretty } from './api.ts';
import { PROVIDER_LABEL, type LedgerRow } from './types.ts';

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

/** "miro (button, conversation)" reads as "Miro"; the detail is in the expanded row. */
const who = (s?: string) => (s ? cap(s.split(' (')[0]) : null);

export function Ledger({ entries, fail }: { entries: LedgerRow[]; fail: (e: unknown) => void }) {
  const rows = [...entries].sort((a, b) => b.seq - a.seq || Date.parse(b.at) - Date.parse(a.at));
  const undone = new Set(entries.map((e) => e.undoOf).filter(Boolean));
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 px-5">
        <span className="text-sm font-semibold">Ledger</span>
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{rows.length ? `${rows.length} entries` : ''}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {rows.length === 0 && (
          <p className="px-5 py-2 text-sm leading-relaxed text-muted-foreground">
            Every tool call the agent makes, and every answer you give, is recorded here.
          </p>
        )}
        <ol className="px-2 pb-4">
          {rows.map((e) => (
            <Row key={e._id} e={e} canUndo={e.undoable && !undone.has(e._id) && e.outcome !== 'undone'} fail={fail} />
          ))}
        </ol>
      </ScrollArea>
    </>
  );
}

function Row({ e, canUndo, fail }: { e: LedgerRow; canUndo: boolean; fail: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const tone = TONE[e.outcome] ?? TONE.undone;
  const decider = who(e.decidedBy);
  return (
    <li>
      <Collapsible className="ledger-arrive group rounded-md">
        <div className="flex items-start gap-3 rounded-md px-3 py-2 hover:bg-muted/60">
          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', tone.dot)} />
          <CollapsibleTrigger className="min-w-0 flex-1 text-left">
            <div className="flex items-baseline gap-2">
              <span className="truncate font-mono text-[13px]">{e.action.replace(/^mcp__gateway__/, '')}</span>
              <span className={cn('text-xs font-medium', tone.text)}>{e.outcome}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <span className="tabular-nums">{clock(e.at)}</span>
              <span>· {PROVIDER_LABEL[e.provider] ?? e.provider}</span>
              {decider && <span>· {decider}</span>}
              <ChevronRightIcon className="size-3 opacity-0 transition group-hover:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
            </div>
          </CollapsibleTrigger>
          {canUndo && (
            <button
              disabled={busy}
              className="mt-0.5 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
              onClick={async () => {
                setBusy(true);
                try { await api.undo(e._id); } catch (err) { fail(err); } finally { setBusy(false); }
              }}
            >
              Undo
            </button>
          )}
        </div>
        <CollapsibleContent>
          <dl className="mx-3 mb-2 ml-8 grid grid-cols-[76px_1fr] gap-x-3 gap-y-1 rounded-md bg-muted/50 p-3 text-xs">
            <dt className="text-muted-foreground">Arguments</dt>
            <dd><pre className="max-h-32 overflow-auto font-mono whitespace-pre-wrap break-all">{pretty(e.args)}</pre></dd>
            <dt className="text-muted-foreground">Rule</dt><dd>{e.ruleId ?? '—'}</dd>
            <dt className="text-muted-foreground">Decided</dt><dd>{e.decidedBy ?? '—'}</dd>
            <dt className="text-muted-foreground">Agent</dt><dd>v{e.agentVersion}</dd>
            <dt className="text-muted-foreground">Connection</dt><dd className="break-all">{e.connectionId ?? '—'}</dd>
            {e.result != null && (
              <>
                <dt className="text-muted-foreground">Result</dt>
                <dd><pre className="max-h-32 overflow-auto font-mono whitespace-pre-wrap break-all">{pretty(e.result)}</pre></dd>
              </>
            )}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
