import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon, AppShell, Badge, Box, Button, Center, Group, Modal, NavLink, Notification, ScrollArea,
  SegmentedControl, Stack, Text, Textarea, TextInput, ThemeIcon, Title, Tooltip,
} from '@mantine/core';
import {
  IconBrandGmail, IconBrandSlack, IconMessagePlus, IconPlayerStopFilled, IconPlus, IconRobot,
  IconShieldCheck, IconX, IconWifiOff,
} from '@tabler/icons-react';
import { api, cap, useConversation } from './api.ts';
import { Chat } from './Chat.tsx';
import { Ledger } from './Ledger.tsx';
import { PROVIDER_LABEL, type Agent, type Connection, type Provider } from './types.ts';

const TOOLKITS = [
  { id: 'slack', label: 'Slack', icon: IconBrandSlack },
  { id: 'gmail', label: 'Gmail', icon: IconBrandGmail },
];

const PROVIDERS = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
];

// Where we are lives in the URL (and localStorage), so the app-connection
// round trip lands back on the same agent and conversation.
function readPlace() {
  const q = new URLSearchParams(location.search);
  return {
    agentId: q.get('agent') ?? localStorage.getItem('agent'),
    conversationId: q.get('conversation') ?? localStorage.getItem('conversation'),
    connected: q.get('connected'),
  };
}

function writePlace(agentId: string | null, conversationId: string | null) {
  const q = new URLSearchParams();
  if (agentId) q.set('agent', agentId);
  if (conversationId) q.set('conversation', conversationId);
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  agentId ? localStorage.setItem('agent', agentId) : localStorage.removeItem('agent');
  conversationId ? localStorage.setItem('conversation', conversationId) : localStorage.removeItem('conversation');
  if (agentId && conversationId) localStorage.setItem(`conversation:${agentId}`, conversationId);
}

export function App() {
  const start = useMemo(readPlace, []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(start.agentId);
  const [conversationId, setConversationId] = useState<string | null>(start.conversationId);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    start.connected ? { text: `${cap(start.connected)} connected`, ok: true } : null,
  );
  const [serverUp, setServerUp] = useState(true);
  const [creating, setCreating] = useState(false);
  const live = useConversation(conversationId, agentId);

  const refreshAgents = () =>
    api.listAgents().then((a) => { setAgents(a); setServerUp(true); }).catch(() => setServerUp(false));

  useEffect(() => { refreshAgents(); const t = setInterval(refreshAgents, 10000); return () => clearInterval(t); }, []);
  useEffect(() => writePlace(agentId, conversationId), [agentId, conversationId]);
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); } }, [notice]);

  const fail = (e: unknown) => setNotice({ text: e instanceof Error ? e.message : String(e), ok: false });
  const agent = agents.find((a) => a._id === agentId) ?? null;

  const selectAgent = async (a: Agent) => {
    setAgentId(a._id);
    const known = localStorage.getItem(`conversation:${a._id}`);
    if (known) { setConversationId(known); return; }
    try {
      const latest = await api.latestConversation(a._id).catch(() => null);
      setConversationId((latest ?? (await api.createConversation(a._id)))._id);
    } catch (e) { fail(e); }
  };

  const newConversation = async () => {
    if (!agentId) return;
    try { setConversationId((await api.createConversation(agentId))._id); } catch (e) { fail(e); }
  };

  const createAgent = async (body: { name: string; instructions: string; defaultProvider: Provider }) => {
    const a = await api.createAgent(body);
    setAgents((list) => [a, ...list.filter((x) => x._id !== a._id)]);
    setAgentId(a._id);
    setConversationId((await api.createConversation(a._id))._id);
  };

  const conv = live.conversation;
  const running =
    Object.values(live.executions).some((x) => x.status === 'running') ||
    Object.values(live.messages).some((m) => m.generating);

  return (
    <AppShell
      header={{ height: 72 }}
      navbar={{ width: 260, breakpoint: 0 }}
      aside={{ width: 380, breakpoint: 0 }}
      padding={0}
    >
      <AppShell.Header>
        <Group h="100%" gap={0} wrap="nowrap">
        <Group gap="xs" w={260} px="md" wrap="nowrap" h="100%" bg="gray.0" style={{ borderRight: '1px solid var(--mantine-color-gray-3)', flexShrink: 0 }}>
          <ThemeIcon size={38} radius="md" variant="filled"><IconShieldCheck size={22} /></ThemeIcon>
          <Box>
            <Text fw={800} lh={1.1}>Governed agents</Text>
            <Text size="xs" c="dimmed">Rules that hold on any engine</Text>
          </Box>
        </Group>
        <Group h="100%" px="lg" flex={1} justify="space-between" wrap="nowrap" miw={0}>
          {agent && conversationId ? (
            <>
              <Group gap="sm" wrap="nowrap" miw={220} style={{ flexShrink: 1 }}>
                <Title order={2} size="h3" lineClamp={1}>{agent.name}</Title>
                <Badge variant="light" color="gray" size="lg" radius="sm" ff="monospace" tt="none">v{agent.version}</Badge>
              </Group>
              <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                <SegmentedControl
                  size="md"
                  radius="md"
                  color={conv?.provider === 'codex' ? 'dark' : 'orange'}
                  disabled={!conv}
                  value={conv?.provider ?? 'claude-code'}
                  data={PROVIDERS}
                  onChange={(p) => conv && p !== conv.provider && api.switchProvider(conv._id, p as Provider).catch(fail)}
                />
                {running && (
                  <Button color="red" size="sm" h={40} leftSection={<IconPlayerStopFilled size={16} />} onClick={() => api.stop(conversationId).catch(fail)}>
                    Stop
                  </Button>
                )}
                <Apps agentId={agent._id} connections={Object.values(live.connections)} fail={fail} />
                <Tooltip label="New conversation">
                  <ActionIcon variant="default" size={40} onClick={newConversation} aria-label="New conversation">
                    <IconMessagePlus size={20} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </>
          ) : (
            <Text c="dimmed" fw={600}>Create an agent to begin</Text>
          )}
        </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md" bg="gray.0">
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt={4} mb={8} style={{ letterSpacing: '.08em' }}>Agents</Text>
        <ScrollArea flex={1}>
          <Stack gap={4}>
            {agents.map((a) => (
              <NavLink
                key={a._id}
                active={a._id === agentId}
                variant="filled"
                onClick={() => selectAgent(a)}
                leftSection={<IconRobot size={20} />}
                label={<Text fw={700} truncate>{a.name}</Text>}
                description={`v${a.version} · ${PROVIDER_LABEL[a.defaultProvider] ?? a.defaultProvider}`}
                style={{ borderRadius: 'var(--mantine-radius-md)' }}
              />
            ))}
            {agents.length === 0 && serverUp && <Text size="sm" c="dimmed">No agents yet.</Text>}
            {!serverUp && (
              <Group gap={6} c="orange.8"><IconWifiOff size={16} /><Text size="sm">Server not answering</Text></Group>
            )}
          </Stack>
        </ScrollArea>
        <Button mt="md" size="md" fullWidth leftSection={<IconPlus size={18} />} onClick={() => setCreating(true)}>
          New agent
        </Button>
      </AppShell.Navbar>

      <AppShell.Main h="100dvh" style={{ display: 'flex', flexDirection: 'column' }}>
        {notice && (
          <Notification
            color={notice.ok ? 'teal' : 'red'}
            onClose={() => setNotice(null)}
            withBorder
            m="md"
            mb={0}
            title={notice.ok ? notice.text : 'Something went wrong'}
          >
            {notice.ok ? null : notice.text}
          </Notification>
        )}
        {agent && conversationId ? (
          <>
            {!live.online && (
              <Group gap={6} c="orange.8" px="lg" pt="sm"><IconWifiOff size={16} /><Text size="sm" fw={600}>Reconnecting…</Text></Group>
            )}
            <Chat live={live} conversationId={conversationId} agentId={agent._id} fail={fail} />
          </>
        ) : (
          <Center flex={1}>
            <Stack align="center" gap="md">
              <ThemeIcon size={72} radius="xl" variant="light"><IconRobot size={40} /></ThemeIcon>
              <Title order={2}>{agents.length ? 'Pick an agent' : 'No agents yet'}</Title>
              <Text c="dimmed" size="lg">Give it a name, instructions and an engine. Its rules come with it.</Text>
              <Button size="lg" leftSection={<IconPlus size={20} />} onClick={() => setCreating(true)}>New agent</Button>
            </Stack>
          </Center>
        )}
      </AppShell.Main>

      <AppShell.Aside bg="gray.0">
        <Ledger entries={Object.values(live.ledger)} fail={fail} />
      </AppShell.Aside>

      <NewAgent opened={creating} onClose={() => setCreating(false)} onCreate={createAgent} />
    </AppShell>
  );
}

function Apps({ agentId, connections, fail }: { agentId: string; connections: Connection[]; fail: (e: unknown) => void }) {
  return (
    <Group gap="xs" wrap="nowrap">
      {TOOLKITS.map(({ id, label, icon: Icon }) => {
        const c = connections
          .filter((x) => x.toolkit?.toLowerCase() === id && x.status !== 'revoked')
          .sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1))[0];
        if (c?.status === 'active') {
          return (
            <Badge
              key={id}
              size="xl"
              radius="xl"
              variant="light"
              color="teal"
              leftSection={<Icon size={16} />}
              rightSection={
                <Tooltip label={`Disconnect ${label}`}>
                  <ActionIcon size="sm" radius="xl" variant="subtle" color="teal" onClick={() => api.disconnect(c._id).catch(fail)} aria-label={`Disconnect ${label}`}>
                    <IconX size={14} />
                  </ActionIcon>
                </Tooltip>
              }
              tt="none"
            >
              {label}
            </Badge>
          );
        }
        return (
          <Button
            key={id}
            variant="default"
            size="sm"
            h={40}
            leftSection={<Icon size={18} />}
            onClick={async () => {
              try { location.href = (await api.connect(agentId, id)).redirectUrl; } catch (e) { fail(e); }
            }}
          >
            {c?.status === 'pending' ? `Finish ${label}` : `Connect ${label}`}
          </Button>
        );
      })}
    </Group>
  );
}

function NewAgent({ opened, onClose, onCreate }: {
  opened: boolean; onClose: () => void;
  onCreate: (b: { name: string; instructions: string; defaultProvider: Provider }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [provider, setProvider] = useState<Provider>('claude-code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      await onCreate({ name: name.trim(), instructions, defaultProvider: provider });
      onClose(); setName(''); setInstructions('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={800} size="xl">New agent</Text>} size="lg" centered radius="lg">
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput label="Name" size="md" data-autofocus autoComplete="off" data-1p-ignore data-lpignore="true" name="agent-title" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Office helper" />
          <Textarea
            autoComplete="off"
            label="Instructions"
            size="md"
            autosize
            minRows={5}
            value={instructions}
            onChange={(e) => setInstructions(e.currentTarget.value)}
            placeholder="What it is for, and how it should behave."
          />
          <Box>
            <Text size="sm" fw={500} mb={4}>Runs on</Text>
            <SegmentedControl fullWidth size="md" value={provider} onChange={(v) => setProvider(v as Provider)} data={PROVIDERS} />
          </Box>
          {error && <Text c="red" size="sm">{error}</Text>}
          <Group justify="flex-end">
            <Button variant="default" size="md" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="md" loading={busy} disabled={!name.trim()}>Create agent</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
