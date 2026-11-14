import { useEffect, useMemo, useRef, useState } from 'react';
import { BotIcon, CheckIcon, ChevronRightIcon, KeyboardIcon, LoaderIcon, MicIcon, MinusIcon, ShieldAlertIcon, ShieldXIcon, XIcon } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { api, cap, pretty, type Live } from './api.ts';
import { PROVIDER_LABEL, type Ask, type LedgerRow, type Message as Msg, type Provider, type Step } from './types.ts';
import { describeCall, refusalStatus, type StepStatus } from './words.ts';

type Item = { kind: 'message'; m: Msg } | { kind: 'ask'; a: Ask };

const time = (s?: string) => (s ? new Date(s).getTime() : 0);
const toolName = (n: string) => n.replace(/^mcp__gateway__/, '');
const VOICE_WIDGET: string = 'http://localhost:4200/widget.js';

/** Each engine's own mark, so it is clear at a glance who is answering. */
function EngineIcon({ provider, className }: { provider: Provider; className?: string }) {
  return <img src={`/engines/${provider}.svg`} alt="" className={cn('size-3.5 shrink-0', className)} />;
}

/** Messages in `seq` order; each ask sits after the last message written before it. */
function timeline(live: Live): Item[] {
  const messages = Object.values(live.messages).sort((a, b) => a.seq - b.seq);
  const side = Object.values(live.asks)
    .map((a) => ({ at: time(a.createdAt), item: { kind: 'ask', a } as Item }))
    .sort((x, y) => x.at - y.at);
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

export function Chat({ live, conversationId, agentId, running, onStop, fail, provider, onSwitch }: {
  live: Live; conversationId: string; agentId: string; running: boolean; onStop: () => void; fail: (e: unknown) => void;
  provider: Provider; onSwitch: (provider: Provider) => void;
}) {
  const items = useMemo(() => timeline(live), [live.messages, live.asks]);
  const asks = Object.values(live.asks);
  const ledger = useMemo(() => Object.values(live.ledger), [live.ledger]);
  const voiceSlot = useRef<HTMLDivElement>(null);

  // The voice service serves its own call widget; when it is down the slot stays empty.
  useEffect(() => {
    const slot = voiceSlot.current;
    if (!slot) return;
    let gone = false;
    let ui: { leave: () => void } | null = null;
    import(/* @vite-ignore */ VOICE_WIDGET)
      .then(({ mountVoice }) => { if (!gone) ui = mountVoice(slot, { conversationId }); })
      .catch(() => {});
    return () => { gone = true; ui?.leave(); slot.innerHTML = ''; };
  }, [conversationId]);

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
              it.kind === 'message' ? <MessageView key={it.m._id} m={it.m} asks={asks} ledger={ledger} />
                : <AskView key={it.a._id} a={it.a} fail={fail} />,
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
              <PromptInputTools>
                <EngineSwitch provider={provider} onSwitch={onSwitch} />
                <Dictate onText={(t) => api.send(conversationId, t, 'voice').catch(fail)} fail={fail} />
              </PromptInputTools>
              <PromptInputSubmit status={running ? 'streaming' : undefined} onStop={onStop} />
            </PromptInputFooter>
          </PromptInput>
          {/* The voice track mounts its call button here. */}
          <div id="voice-slot" ref={voiceSlot} data-conversation-id={conversationId} data-agent-id={agentId} />
        </div>
      </div>
    </>
  );
}

/** Speak a message: records until clicked again, then sends the transcript as a spoken message. */
function Dictate({ onText, fail }: { onText: (text: string) => void; fail: (e: unknown) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const recorder = useRef<MediaRecorder | null>(null);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState('transcribing');
        try {
          const text = (await api.transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))).trim();
          if (text) onText(text);
          else fail(new Error('Nothing was heard. Try again.'));
        } catch (e) { fail(e); } finally { setState('idle'); }
      };
      recorder.current = rec;
      rec.start();
      setState('recording');
    } catch (e) { fail(e); }
  };

  return (
    <button
      type="button"
      disabled={state === 'transcribing'}
      onClick={() => (state === 'recording' ? recorder.current?.stop() : start())}
      aria-label={state === 'recording' ? 'Stop and send' : 'Speak a message'}
      title={state === 'recording' ? 'Stop and send' : 'Speak a message'}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition',
        state === 'recording' ? 'bg-red-600 text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {state === 'transcribing' ? <LoaderIcon className="size-3.5 animate-spin" /> : <MicIcon className="size-3.5" />}
      {state === 'recording' && 'Listening… click to send'}
      {state === 'transcribing' && 'Transcribing'}
    </button>
  );
}

/** Which engine runs the agent; it can be changed at any moment, even mid-turn. */
function EngineSwitch({ provider, onSwitch }: { provider: Provider; onSwitch: (provider: Provider) => void }) {
  return (
    <div role="tablist" aria-label="Engine" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={p === provider}
          onClick={() => onSwitch(p)}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition',
            p === provider ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <EngineIcon provider={p} className={p === provider ? '' : 'opacity-60'} />
          {PROVIDER_LABEL[p]}
        </button>
      ))}
    </div>
  );
}

function ProviderBadge({ provider }: { provider?: Provider }) {
  if (!provider) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <EngineIcon provider={provider} />
      {PROVIDER_LABEL[provider] ?? provider}
    </span>
  );
}

function MessageView({ m, asks, ledger }: { m: Msg; asks: Ask[]; ledger: LedgerRow[] }) {
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
        <Body m={m} asks={asks} ledger={ledger} />
      </MessageContent>
    </Message>
  );
}

/** The reply in the order it happened: text and tool calls interleaved. */
function Body({ m, asks, ledger }: { m: Msg; asks: Ask[]; ledger: LedgerRow[] }) {
  const steps = m.steps ?? [];
  const responses = new Map<string, Extract<Step, { toolResponse: unknown }>['toolResponse']>();
  for (const s of steps) if ('toolResponse' in s) responses.set(s.toolResponse.ref, s.toolResponse);
  const hasTextSteps = steps.some((s) => 'text' in s);
  const tool = (req: { ref: string; name: string; input: unknown }, key: string | number) => (
    <ToolCall key={key} req={req} res={responses.get(req.ref)} asks={asks} ledger={ledger} />
  );

  if (!hasTextSteps) {
    return (
      <>
        {steps.map((s, i) => 'toolRequest' in s && tool(s.toolRequest, i))}
        {m.text && <MessageResponse isAnimating={m.generating}>{plainFailure(m.text)}</MessageResponse>}
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

/** A turn that could not run says so in words a person can act on. */
function plainFailure(text: string): string {
  if (!/^The turn could not run:/.test(text)) return text;
  return 'This turn was cut off before it finished. Send the message again.';
}

const STEP_TONE: Record<StepStatus['tone'], { chip: string; icon: string }> = {
  ok: { chip: 'bg-emerald-50 text-emerald-700', icon: 'text-emerald-600' },
  running: { chip: 'bg-muted text-muted-foreground', icon: 'text-muted-foreground' },
  waiting: { chip: 'bg-amber-50 text-amber-700', icon: 'text-amber-600' },
  blocked: { chip: 'bg-red-50 text-red-700', icon: 'text-red-600' },
  quiet: { chip: 'bg-muted text-muted-foreground', icon: 'text-muted-foreground' },
  failed: { chip: 'bg-red-50 text-red-700', icon: 'text-red-600' },
};

/** One tool call in plain words, with where it stands. A refusal is not an error. */
function ToolCall({ req, res, asks, ledger }: {
  req: { ref: string; name: string; input: unknown };
  res?: { output: unknown; isError: boolean };
  asks: Ask[];
  ledger: LedgerRow[];
}) {
  const name = toolName(req.name);
  const title = describeCall(name, req.input, ledger);
  const waiting = asks.some((a) => a.status === 'open' && (a.action === name || title.toLowerCase().includes(a.summary.toLowerCase())));
  let status: StepStatus;
  if (!res) status = waiting ? { tone: 'waiting', label: 'Waiting for your approval' } : { tone: 'running', label: 'Running' };
  else if (res.isError) status = refusalStatus(reasonOf(res.output));
  else status = { tone: 'ok', label: 'Done' };
  const tone = STEP_TONE[status.tone];
  const Icon = { ok: CheckIcon, running: LoaderIcon, waiting: ShieldAlertIcon, blocked: ShieldXIcon, quiet: MinusIcon, failed: XIcon }[status.tone];

  return (
    <Collapsible className="group rounded-lg border bg-background">
      <CollapsibleTrigger className="flex w-full items-start gap-2.5 px-3 py-2 text-left">
        <Icon className={cn('mt-0.5 size-4 shrink-0', tone.icon, status.tone === 'running' && 'animate-spin')} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] leading-snug break-words">{title}</span>
          {status.detail && <span className="mt-0.5 block text-xs text-muted-foreground">{status.detail}</span>}
        </span>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', tone.chip)}>{status.label}</span>
        <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 border-t px-3 py-2 text-xs">
          <div className="font-mono text-[11px] text-muted-foreground">{name}</div>
          <pre className="max-h-40 overflow-auto font-mono whitespace-pre-wrap break-all">{pretty(req.input)}</pre>
          {res && <pre className="max-h-40 overflow-auto border-t pt-2 font-mono whitespace-pre-wrap break-all text-muted-foreground">{res.isError ? reasonOf(res.output) : pretty(res.output)}</pre>}
        </div>
      </CollapsibleContent>
    </Collapsible>
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

/** The words of a refusal, whatever shape the tool result came in. */
function reasonOf(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(reasonOf).filter(Boolean).join(' ');
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.reason === 'string') return o.reason;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.error === 'string') return o.error;
    if (o.content) return reasonOf(o.content);
  }
  return JSON.stringify(output);
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
