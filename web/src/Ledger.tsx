import { useState } from 'react';
import { ChevronDownIcon, ScrollTextIcon, Undo2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { api, cap, pretty } from './api.ts';
import { PROVIDER_LABEL, type LedgerRow } from './types.ts';

/** One colour per outcome: green went ahead, amber waits, red stopped, grey reversed. */
const OUTCOME: Record<string, { pill: string; edge: string }> = {
  allowed: { pill: 'bg-emerald-100 text-emerald-800', edge: 'border-l-emerald-500' },
  approved: { pill: 'bg-emerald-100 text-emerald-800', edge: 'border-l-emerald-500' },
  executed: { pill: 'bg-green-600 text-white', edge: 'border-l-green-600' },
  asked: { pill: 'bg-amber-100 text-amber-800', edge: 'border-l-amber-500' },
  declined: { pill: 'bg-red-100 text-red-800', edge: 'border-l-red-500' },
  denied: { pill: 'bg-red-600 text-white', edge: 'border-l-red-600' },
  failed: { pill: 'bg-red-100 text-red-800', edge: 'border-l-red-500' },
  undone: { pill: 'bg-zinc-200 text-zinc-700', edge: 'border-l-zinc-400' },
};

const clock = (s: string) =>
  new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function Ledger({ entries, fail }: { entries: LedgerRow[]; fail: (e: unknown) => void }) {
  const rows = [...entries].sort((a, b) => b.seq - a.seq || Date.parse(b.at) - Date.parse(a.at));
  const undone = new Set(entries.map((e) => e.undoOf).filter(Boolean));
  return (
    <>
      <div className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <ScrollTextIcon className="size-5" />
        <span className="font-semibold">Ledger</span>
        <span className="relative ml-1 flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
        <span className="ml-auto text-xs text-muted-foreground">every tool call, live</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3">
          {rows.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">Nothing yet. Each tool call the agent makes, and each answer you give, lands here.</p>
          )}
          {rows.map((e) => (
            <Row key={e._id} e={e} canUndo={e.undoable && !undone.has(e._id) && e.outcome !== 'undone'} fail={fail} />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

function Row({ e, canUndo, fail }: { e: LedgerRow; canUndo: boolean; fail: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const style = OUTCOME[e.outcome] ?? OUTCOME.undone;
  return (
    <Collapsible className={cn('ledger-arrive group rounded-lg border border-l-4 bg-card shadow-xs', style.edge)}>
      <CollapsibleTrigger className="w-full px-3 py-2.5 text-left">
        <div className="flex items-center gap-2">
          <span className={cn('w-[86px] shrink-0 rounded-md px-2 py-0.5 text-center text-xs font-semibold uppercase tracking-wide', style.pill)}>
            {e.outcome}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{e.action.replace(/^mcp__gateway__/, '')}</span>
          <span className="font-mono text-xs text-muted-foreground">{clock(e.at)}</span>
          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{PROVIDER_LABEL[e.provider] ?? e.provider}</span>
          {e.decidedBy && <span className="truncate">· {cap(e.decidedBy)}</span>}
          {canUndo && (
            <Button
              asChild
              size="xs"
              variant="outline"
              className="ml-auto h-6"
              onClick={async (ev: React.MouseEvent) => {
                ev.stopPropagation(); setBusy(true);
                try { await api.undo(e._id); } catch (err) { fail(err); } finally { setBusy(false); }
              }}
            >
              <span role="button" aria-disabled={busy}><Undo2Icon /> Undo</span>
            </Button>
          )}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 border-t px-3 py-2.5 text-xs">
          <dt className="text-muted-foreground">Arguments</dt>
          <dd><pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all">{pretty(e.args)}</pre></dd>
          <dt className="text-muted-foreground">Rule</dt><dd>{e.ruleId ?? '—'}</dd>
          <dt className="text-muted-foreground">Agent</dt><dd>v{e.agentVersion}</dd>
          <dt className="text-muted-foreground">Connection</dt><dd className="break-all">{e.connectionId ?? '—'}</dd>
          {e.result != null && (
            <>
              <dt className="text-muted-foreground">Result</dt>
              <dd><pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all">{pretty(e.result)}</pre></dd>
            </>
          )}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
