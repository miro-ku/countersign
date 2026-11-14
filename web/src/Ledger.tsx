import { useState } from 'react';
import { api, cap, pretty } from './api.ts';
import { PROVIDER_LABEL, type LedgerRow } from './types.ts';

const clock = (s: string) =>
  new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function Ledger({ entries, fail }: { entries: LedgerRow[]; fail: (e: unknown) => void }) {
  const rows = [...entries].sort((a, b) => b.seq - a.seq || Date.parse(b.at) - Date.parse(a.at));
  const undone = new Set(entries.map((e) => e.undoOf).filter(Boolean));
  return (
    <aside className="ledger">
      <div className="ledger-title">Ledger <span className="live-dot" /> </div>
      {rows.length === 0 && <div className="ledger-empty">Every tool call the agent makes is recorded here.</div>}
      <ol>
        {rows.map((e) => <Row key={e._id} e={e} canUndo={e.undoable && !undone.has(e._id) && e.outcome !== 'undone'} fail={fail} />)}
      </ol>
    </aside>
  );
}

function Row({ e, canUndo, fail }: { e: LedgerRow; canUndo: boolean; fail: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <li className={`row${open ? ' open' : ''}`}>
      <div className="row-line" onClick={() => setOpen(!open)}>
        <span className="row-time">{clock(e.at)}</span>
        <span className={`outcome ${e.outcome}`}>{e.outcome}</span>
        <span className="row-action">{e.action.replace(/^mcp__gateway__/, '')}</span>
      </div>
      <div className="row-sub">
        <span>{PROVIDER_LABEL[e.provider] ?? e.provider}</span>
        {e.decidedBy && <span>· {cap(e.decidedBy)}</span>}
        {canUndo && (
          <button
            className="undo"
            disabled={busy}
            onClick={async (ev) => {
              ev.stopPropagation(); setBusy(true);
              try { await api.undo(e._id); } catch (err) { fail(err); } finally { setBusy(false); }
            }}
          >
            Undo
          </button>
        )}
      </div>
      {open && (
        <dl className="row-detail">
          <dt>Arguments</dt><dd><pre>{pretty(e.args)}</pre></dd>
          <dt>Rule</dt><dd>{e.ruleId ?? 'none (asked by default)'}</dd>
          <dt>Agent version</dt><dd>v{e.agentVersion}</dd>
          <dt>Connection</dt><dd>{e.connectionId ?? '—'}</dd>
          {e.result !== undefined && (<><dt>Result</dt><dd><pre>{pretty(e.result)}</pre></dd></>)}
        </dl>
      )}
    </li>
  );
}
