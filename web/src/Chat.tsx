import { useMemo, useState } from 'react';
import { BotIcon, CheckIcon, KeyboardIcon, MicIcon, MinusIcon, ShieldAlertIcon, XIcon } from 'lucide-react';
import {
  Confirmation, ConfirmationAction, ConfirmationActions, ConfirmationRequest, ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import {
  Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from '@/components/ai-elements/tool';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { api, cap, type Live } from './api.ts';
import { PROVIDER_LABEL, type Ask, type LedgerRow, type Message as Msg, type Provider, type Step } from './types.ts';

type Item = { kind: 'message'; m: Msg } | { kind: 'ask'; a: Ask } | { kind: 'decision'; e: LedgerRow };

const time = (s?: string) => (s ? new Date(s).getTime() : 0);
const toolName = (n: string) => n.replace(/^mcp__gateway__/, '');

const PROVIDER_DOT: Record<Provider, string> = {
  'claude-code': 'bg-orange-500',
  codex: 'bg-zinc-900',
};

/**
 * Messages in `seq` order; each ask sits after the last message written before
 * it. The snapshot only carries open asks, so an answer this browser never saw
 * is shown from its ledger entry instead.
 */
function timeline(live: Live): Item[] {
  const messages = Object.values(live.messages).sort((a, b) => a.seq - b.seq);
  const asks = Object.values(live.asks);
  const seen = new Set(asks.map((a) => a.fingerprint));
  const side: { at: number; item: Item }[] = [
    ...asks.map((a) => ({ at: time(a.createdAt), item: { kind: 'ask', a } as Item })),
    ...Object.values(live.ledger)
      .filter((e) => (e.outcome === 'approved' || e.outcome === 'declined') && !seen.has(e.fingerprint))
      .map((e) => ({ at: time(e.at), item: { kind: 'decision', e } as Item })),
  ].sort((x, y) => x.at - y.at);
  const items: Item[] = [];
  let i = 0;
  for (const m of messages) {
    while (i < side.length && side[i].at < time(m.at)) items.push(side[i++].item);
    const prev = items[items.length - 1];
    if (m.role === 'event' && prev?.kind === 'message' && prev.m.role === 'event' && prev.m.text === m.text) continue;
    items.push({ kind: 'message', m });
  }
  while (i < side.length) items.push(side[i++].item);
  return items;
}

export function Chat({ live, conversationId, agentId, running, onStop, fail }: {
  live: Live; conversationId: string; agentId: string; running: boolean; onStop: () => void; fail: (e: unknown) => void;
}) {
  const items = useMemo(() => timeline(live), [live.messages, live.asks, live.ledger]);
  const asks = Object.values(live.asks);

  return (
    <>
      <Conversation key={conversationId} className="min-h-0">
        <ConversationContent className="mx-auto w-full max-w-2xl gap-6 px-6 py-8">
          {items.length === 0 ? (
            <ConversationEmptyState
              className="min-h-[50vh]"
              icon={<BotIcon className="size-6" />}
              title="New conversation"
              description="Ask it something. Anything that touches your apps is checked first."
            />
          ) : (
            items.map((it) =>
              it.kind === 'message' ? <MessageView key={it.m._id} m={it.m} asks={asks} />
                : it.kind === 'ask' ? <AskView key={it.a._id} a={it.a} fail={fail} />
                : <DecisionLine key={it.e._id} e={it.e} />,
            )
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-2xl px-6 pb-5">
        <div className="flex items-end gap-2">
          <PromptInput
            className="flex-1"
            onSubmit={({ text }) => {
              const t = text.trim();
              if (t) api.send(conversationId, t).catch(fail);
            }}
          >
            <PromptInputBody>
              <PromptInputTextarea placeholder="Message the agent…" aria-label="Message" className="min-h-11 text-sm" />
            </PromptInputBody>
            <PromptInputFooter className="pt-0">
              <PromptInputTools />
              <PromptInputSubmit status={running ? 'streaming' : undefined} onStop={onStop} />
            </PromptInputFooter>
          </PromptInput>
          {/* The voice track mounts its call button here. */}
          <div id="voice-slot" className="pb-1" data-conversation-id={conversationId} data-agent-id={agentId} />
        </div>
      </div>
    </>
  );
}

function ProviderBadge({ provider }: { provider?: Provider }) {
  if (!provider) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className={cn('size-1.5 rounded-full', PROVIDER_DOT[provider])} />
      {PROVIDER_LABEL[provider] ?? provider}
    </span>
  );
}

function MessageView({ m, asks }: { m: Msg; asks: Ask[] }) {
  if (m.role === 'event') {
    const text = m.text.replace(/\bclaude-code\b/g, 'Claude Code').replace(/\bcodex\b/g, 'Codex');
    return (
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border/70" />{text}<div className="h-px flex-1 bg-border/70" />
      </div>
    );
  }
  if (m.role === 'user') {
    const spoken = m.source === 'voice';
    return (
      <Message from="user" className="max-w-[80%] gap-1">
        <MessageContent className="rounded-2xl text-[15px] leading-relaxed group-[.is-user]:px-4 group-[.is-user]:py-2.5">
          {m.text}
        </MessageContent>
        <div className="ml-auto flex items-center gap-1 pr-1 text-[11px] text-muted-foreground">
          {spoken ? <MicIcon className="size-3" /> : <KeyboardIcon className="size-3" />}
          {spoken ? 'spoken' : 'typed'}
        </div>
      </Message>
    );
  }
  return (
    <Message from="assistant" className="gap-1.5">
      <div className="flex items-center gap-2">
        <ProviderBadge provider={m.provider} />
        {m.generating && <Shimmer className="text-xs">writing…</Shimmer>}
      </div>
      <MessageContent className="w-full gap-3 text-[15px] leading-relaxed">
        <Body m={m} asks={asks} />
      </MessageContent>
    </Message>
  );
}

/** The reply in the order it happened: text and tool calls interleaved. */
function Body({ m, asks }: { m: Msg; asks: Ask[] }) {
  const steps = m.steps ?? [];
  const responses = new Map<string, Extract<Step, { toolResponse: unknown }>['toolResponse']>();
  for (const s of steps) if ('toolResponse' in s) responses.set(s.toolResponse.ref, s.toolResponse);
  const hasTextSteps = steps.some((s) => 'text' in s);
  const tool = (req: { ref: string; name: string; input: unknown }, key: string | number) => (
    <ToolCall key={key} req={req} res={responses.get(req.ref)} asks={asks} />
  );

  if (!hasTextSteps) {
    return (
      <>
        {steps.map((s, i) => 'toolRequest' in s && tool(s.toolRequest, i))}
        {m.text && <MessageResponse isAnimating={m.generating}>{m.text}</MessageResponse>}
      </>
    );
  }
  return (
    <>
      {steps.map((s, i) => {
        if ('text' in s) return s.text.trim() ? <MessageResponse key={i} isAnimating={m.generating}>{s.text}</MessageResponse> : null;
        if ('toolRequest' in s) return tool(s.toolRequest, i);
        return null;
      })}
    </>
  );
}

/** A tool call row, with the status it is in right now. */
function ToolCall({ req, res, asks }: {
  req: { ref: string; name: string; input: unknown };
  res?: { output: unknown; isError: boolean };
  asks: Ask[];
}) {
  const name = toolName(req.name);
  const ask = asks.find((a) => a.action === name && JSON.stringify(a.args) === JSON.stringify(req.input));
  let state: ToolPart['state'];
  if (!res) state = ask?.status === 'open' ? 'approval-requested' : 'input-available';
  else if (res.isError) state = ask?.status === 'declined' ? 'output-denied' : 'output-error';
  else state = 'output-available';
  const errorText = res?.isError ? (typeof res.output === 'string' ? res.output : JSON.stringify(res.output)) : undefined;

  return (
    <Tool className="mb-0 rounded-lg bg-background">
      <ToolHeader type="dynamic-tool" toolName={name} state={state} title={name} className="px-3 py-2 [&>div>span:not([data-slot])]:font-mono [&>div>span:not([data-slot])]:text-[13px] [&>div>span:not([data-slot])]:font-normal" />
      <ToolContent>
        <ToolInput input={req.input} />
        {res && <ToolOutput output={res.isError ? undefined : res.output} errorText={errorText} />}
      </ToolContent>
    </Tool>
  );
}

function QuietLine({ kind, line, what }: { kind: string; line: string; what: string }) {
  const tone = kind === 'approved' ? 'text-emerald-700 bg-emerald-100' : kind === 'declined' ? 'text-red-700 bg-red-100' : 'text-muted-foreground bg-muted';
  const Icon = kind === 'approved' ? CheckIcon : kind === 'declined' ? XIcon : MinusIcon;
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full', tone)}><Icon className="size-3" /></span>
      <span className={cn('shrink-0 font-medium', tone.split(' ')[0])}>{line}</span>
      <span className="truncate text-muted-foreground">· {what}</span>
    </div>
  );
}

function DecisionLine({ e }: { e: LedgerRow }) {
  const ok = e.outcome === 'approved';
  return <QuietLine kind={e.outcome} line={`${ok ? 'Approved' : 'Rejected'} by ${cap(e.decidedBy ?? 'miro')}`} what={toolName(e.action)} />;
}

function AskView({ a, fail }: { a: Ask; fail: (e: unknown) => void }) {
  const [forConversation, setForConversation] = useState(true);
  const [busy, setBusy] = useState(false);

  if (a.status === 'replied' || a.status === 'stopped') {
    return <QuietLine kind={a.status} line={a.status === 'replied' ? 'Not answered: Miro wrote something else' : 'Stopped before an answer'} what={a.summary} />;
  }
  if (a.status !== 'open') {
    const ans = a.answer;
    const who = cap(ans?.by ?? 'miro');
    const how = ans?.source === 'voice' ? ` (voice: '${ans.transcript ?? ''}')` : '';
    const scope = ans?.scope === 'conversation' || a.status === 'declined' ? ', for this conversation' : ', once';
    return <QuietLine kind={a.status} line={`${a.status === 'approved' ? 'Approved' : 'Rejected'} by ${who}${how}${scope}`} what={a.summary} />;
  }

  const answer = async (choice: 'approve' | 'decline') => {
    setBusy(true);
    try { await api.answer(a._id, choice, forConversation ? 'conversation' : 'once'); }
    catch (e) { fail(e); setBusy(false); }
  };

  return (
    <Confirmation approval={{ id: a._id }} state="approval-requested" className="gap-3 rounded-xl border-amber-300 bg-amber-50/70 p-4 shadow-sm">
      <ConfirmationTitle className="flex flex-col gap-1 text-foreground">
        <span className="flex items-center gap-1.5 text-xs font-medium text-amber-700">
          <ShieldAlertIcon className="size-3.5" /> Approval needed · asked by {PROVIDER_LABEL[a.askedByProvider] ?? a.askedByProvider}
        </span>
        <span className="text-base font-medium leading-snug">{a.summary}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{toolName(a.action)}</span>
      </ConfirmationTitle>
      <ConfirmationRequest>
        <div className="flex flex-wrap items-center gap-3">
          <ConfirmationActions className="justify-start">
            <ConfirmationAction size="sm" disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => answer('approve')}>
              <CheckIcon /> Approve
            </ConfirmationAction>
            <ConfirmationAction size="sm" variant="outline" disabled={busy} className="bg-background text-red-700 hover:bg-red-50 hover:text-red-700" onClick={() => answer('decline')}>
              <XIcon /> Reject
            </ConfirmationAction>
          </ConfirmationActions>
          <label className="ml-1 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={forConversation} onCheckedChange={(v) => setForConversation(v === true)} />
            for this conversation
          </label>
        </div>
      </ConfirmationRequest>
    </Confirmation>
  );
}
