import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon, Avatar, Badge, Box, Button, Center, Checkbox, Code, Collapse, Divider, Group, Loader, Paper,
  Stack, Text, TextInput, ThemeIcon, UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle, IconArrowUp, IconCheck, IconChevronDown, IconChevronRight, IconCircleCheckFilled,
  IconCircleXFilled, IconKeyboard, IconMicrophone, IconMinus, IconRobot, IconTool, IconX,
} from '@tabler/icons-react';
import { api, cap, pretty, type Live } from './api.ts';
import { PROVIDER_LABEL, type Ask, type LedgerRow, type Message, type Provider, type Step } from './types.ts';

type Item = { kind: 'message'; m: Message } | { kind: 'ask'; a: Ask } | { kind: 'decision'; e: LedgerRow };

const time = (s?: string) => (s ? new Date(s).getTime() : 0);
export const providerColor = (p?: Provider) => (p === 'codex' ? 'dark' : 'orange');

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
    items.push({ kind: 'message', m });
  }
  while (i < side.length) items.push(side[i++].item);
  return items;
}

export function Chat({ live, conversationId, agentId, fail }: {
  live: Live; conversationId: string; agentId: string; fail: (e: unknown) => void;
}) {
  const items = useMemo(() => timeline(live), [live.messages, live.asks, live.ledger]);
  const scroller = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');

  // Start at the bottom once the conversation has loaded, then follow it
  // while the reader is near the bottom.
  const landed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (landed.current !== conversationId && items.length) { landed.current = conversationId; el.scrollTop = el.scrollHeight; return; }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 280) el.scrollTop = el.scrollHeight;
  });

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    api.send(conversationId, t).catch((err) => { setText(t); fail(err); });
  };

  return (
    <>
      <Box ref={scroller} flex={1} style={{ overflowY: 'auto' }} px="xl" py="lg">
        <Stack gap="lg" maw={900} mx="auto">
          {items.length === 0 && (
            <Center mih="50vh">
              <Stack align="center" gap={6}>
                <ThemeIcon size={56} radius="xl" variant="light"><IconRobot size={30} /></ThemeIcon>
                <Text size="lg" fw={600}>New conversation</Text>
                <Text c="dimmed">Type a message, or start a call.</Text>
              </Stack>
            </Center>
          )}
          {items.map((it) =>
            it.kind === 'message' ? <MessageView key={it.m._id} m={it.m} />
              : it.kind === 'ask' ? <AskView key={it.a._id} a={it.a} fail={fail} />
              : <DecisionLine key={it.e._id} e={it.e} />,
          )}
        </Stack>
      </Box>
      <Box px="xl" py="md" style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}>
        <form onSubmit={send} style={{ maxWidth: 900, margin: '0 auto' }}>
          <Group gap="sm" wrap="nowrap">
            <TextInput
              flex={1}
              size="lg"
              radius="xl"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              placeholder="Message the agent…"
              aria-label="Message"
              rightSectionWidth={56}
              rightSection={
                <ActionIcon type="submit" size={40} radius="xl" disabled={!text.trim()} aria-label="Send">
                  <IconArrowUp size={22} />
                </ActionIcon>
              }
            />
            {/* The voice track mounts its call button here. */}
            <div id="voice-slot" data-conversation-id={conversationId} data-agent-id={agentId} />
          </Group>
        </form>
      </Box>
    </>
  );
}

function MessageView({ m }: { m: Message }) {
  if (m.role === 'event') {
    const text = m.text.replace(/\bclaude-code\b/g, 'Claude Code').replace(/\bcodex\b/g, 'Codex');
    return <Divider my={4} labelPosition="center" label={<Text size="sm" fw={600} c="dimmed">{text}</Text>} />;
  }
  if (m.role === 'user') {
    const spoken = m.source === 'voice';
    return (
      <Stack gap={4} align="flex-end">
        <Group gap={6} c="dimmed">
          {spoken ? <IconMicrophone size={14} /> : <IconKeyboard size={14} />}
          <Text size="xs" fw={600}>Miro · {spoken ? 'spoken' : 'typed'}</Text>
        </Group>
        <Paper bg="dark.7" c="white" px="lg" py="sm" radius="lg" maw="75%" style={{ borderBottomRightRadius: 4 }}>
          <Text style={{ whiteSpace: 'pre-wrap' }}>{m.text}</Text>
        </Paper>
      </Stack>
    );
  }
  const color = providerColor(m.provider);
  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <Avatar color={color} variant="filled" radius="xl" size={40}><IconRobot size={22} /></Avatar>
      <Stack gap={6} maw="85%" miw={0}>
        <Group gap={8}>
          <Badge color={color} variant="light" radius="sm">{m.provider ? PROVIDER_LABEL[m.provider] ?? m.provider : 'Agent'}</Badge>
          {m.generating && <Group gap={6}><Loader size={12} color={color} type="dots" /><Text size="xs" c="dimmed">writing</Text></Group>}
        </Group>
        <Paper withBorder radius="lg" px="lg" py="sm" style={{ borderTopLeftRadius: 4 }} shadow="xs">
          <Stack gap="xs"><Body m={m} /></Stack>
        </Paper>
      </Stack>
    </Group>
  );
}

/** The reply in the order it happened: text and tool calls interleaved. */
function Body({ m }: { m: Message }) {
  const steps = m.steps ?? [];
  const responses = new Map<string, Extract<Step, { toolResponse: unknown }>['toolResponse']>();
  for (const s of steps) if ('toolResponse' in s) responses.set(s.toolResponse.ref, s.toolResponse);
  const hasTextSteps = steps.some((s) => 'text' in s);
  const caret = m.generating ? <span className="caret" /> : null;

  if (!hasTextSteps) {
    return (
      <>
        {steps.map((s) => 'toolRequest' in s && <ToolRow key={s.toolRequest.ref} req={s.toolRequest} res={responses.get(s.toolRequest.ref)} />)}
        {(m.text || caret) && <Text style={{ whiteSpace: 'pre-wrap' }}>{m.text}{caret}</Text>}
      </>
    );
  }
  return (
    <>
      {steps.map((s, i) => {
        if ('text' in s) return s.text.trim() ? <Text key={i} style={{ whiteSpace: 'pre-wrap' }}>{s.text.trim()}</Text> : null;
        if ('toolRequest' in s) return <ToolRow key={i} req={s.toolRequest} res={responses.get(s.toolRequest.ref)} />;
        return null;
      })}
      {caret && <Text>{caret}</Text>}
    </>
  );
}

const toolName = (n: string) => n.replace(/^mcp__gateway__/, '');

function oneLine(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const o = input as Record<string, any>;
  if (Array.isArray(o.tools)) return o.tools.map((t: any) => t?.tool_slug ?? '?').join(', ');
  return Object.entries(o)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('  ');
}

function ToolRow({ req, res }: {
  req: { ref: string; name: string; input: unknown };
  res?: { output: unknown; isError: boolean };
}) {
  const [open, setOpen] = useState(false);
  const icon = !res ? <Loader size={14} color="gray" />
    : res.isError ? <IconCircleXFilled size={18} color="var(--mantine-color-red-7)" />
    : <IconCircleCheckFilled size={18} color="var(--mantine-color-teal-7)" />;
  return (
    <Paper bg="gray.0" radius="md" withBorder>
      <UnstyledButton onClick={() => setOpen(!open)} w="100%" px="sm" py={6}>
        <Group gap={8} wrap="nowrap">
          {icon}
          <IconTool size={15} color="var(--mantine-color-gray-6)" />
          <Text ff="monospace" size="sm" fw={700}>{toolName(req.name)}</Text>
          <Text size="sm" c="dimmed" truncate flex={1}>{oneLine(req.input)}</Text>
          {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Box px="sm" pb="sm">
          <Text size="xs" fw={700} c="dimmed" mb={2}>INPUT</Text>
          <Code block>{pretty(req.input)}</Code>
          <Text size="xs" fw={700} c="dimmed" mt="xs" mb={2}>RESULT</Text>
          <Code block mah={240} style={{ overflow: 'auto' }}>{res ? pretty(res.output) : 'still running'}</Code>
        </Box>
      </Collapse>
    </Paper>
  );
}

function QuietLine({ kind, line, what }: { kind: string; line: string; what: string }) {
  const color = kind === 'approved' ? 'teal' : kind === 'declined' ? 'red' : 'gray';
  const Icon = kind === 'approved' ? IconCheck : kind === 'declined' ? IconX : IconMinus;
  return (
    <Group gap={8} wrap="nowrap" pl={52}>
      <ThemeIcon size={22} radius="xl" color={color} variant="light"><Icon size={14} /></ThemeIcon>
      <Text size="sm" fw={700} c={color === 'gray' ? 'dimmed' : `${color}.8`} style={{ whiteSpace: 'nowrap' }}>{line}</Text>
      <Text size="sm" c="dimmed" truncate>· {what}</Text>
    </Group>
  );
}

function DecisionLine({ e }: { e: LedgerRow }) {
  const ok = e.outcome === 'approved';
  return <QuietLine kind={e.outcome} line={`${ok ? 'Approved' : 'Rejected'} by ${cap(e.decidedBy ?? 'miro')}`} what={toolName(e.action)} />;
}

function AskView({ a, fail }: { a: Ask; fail: (e: unknown) => void }) {
  const [forConversation, setForConversation] = useState(true);
  const [busy, setBusy] = useState<null | 'approve' | 'decline'>(null);
  const by = PROVIDER_LABEL[a.askedByProvider] ?? a.askedByProvider;

  if (a.status !== 'open') {
    const ans = a.answer;
    let line: string;
    if (a.status === 'approved' || a.status === 'declined') {
      const who = cap(ans?.by ?? 'miro');
      const how = ans?.source === 'voice' ? ` (voice: '${ans.transcript ?? ''}')` : '';
      const scope = ans?.scope === 'conversation' || a.status === 'declined' ? ', for this conversation' : ', once';
      line = `${a.status === 'approved' ? 'Approved' : 'Rejected'} by ${who}${how}${scope}`;
    } else if (a.status === 'replied') {
      line = 'Not answered: Miro wrote something else';
    } else {
      line = 'Stopped before an answer';
    }
    return <QuietLine kind={a.status} line={line} what={a.summary} />;
  }

  const answer = async (choice: 'approve' | 'decline') => {
    setBusy(choice);
    try { await api.answer(a._id, choice, forConversation ? 'conversation' : 'once'); }
    catch (e) { fail(e); setBusy(null); }
  };

  return (
    <Paper radius="lg" p="lg" shadow="md" className="ask-card" ml={52}>
      <Group gap="xs" mb="xs">
        <IconAlertTriangle size={18} color="var(--mantine-color-yellow-8)" />
        <Text size="sm" fw={800} c="yellow.9" tt="uppercase" style={{ letterSpacing: '.05em' }}>Needs your approval</Text>
        <Badge color={providerColor(a.askedByProvider)} variant="light" radius="sm">asked on {by}</Badge>
      </Group>
      <Text size="xl" fw={700} lh={1.3}>{a.summary}</Text>
      <Text size="sm" c="dimmed" ff="monospace" mt={4}>{toolName(a.action)}</Text>
      <Group mt="md" gap="sm">
        <Button size="md" color="teal" leftSection={<IconCheck size={18} />} loading={busy === 'approve'} disabled={!!busy} onClick={() => answer('approve')}>
          Approve
        </Button>
        <Button size="md" color="red" variant="outline" leftSection={<IconX size={18} />} loading={busy === 'decline'} disabled={!!busy} onClick={() => answer('decline')}>
          Reject
        </Button>
        <Checkbox
          ml="sm"
          size="md"
          label="for this conversation"
          checked={forConversation}
          onChange={(e) => setForConversation(e.currentTarget.checked)}
        />
      </Group>
    </Paper>
  );
}
