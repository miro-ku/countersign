import { useState } from 'react';
import { Badge, Box, Button, Code, Collapse, Group, Paper, ScrollArea, Stack, Table, Text, UnstyledButton } from '@mantine/core';
import { IconArrowBackUp, IconBook2 } from '@tabler/icons-react';
import { api, cap, pretty } from './api.ts';
import { PROVIDER_LABEL, type LedgerRow } from './types.ts';

const OUTCOME_COLOR: Record<string, string> = {
  allowed: 'teal', approved: 'teal', executed: 'green',
  asked: 'yellow', declined: 'red', denied: 'red', failed: 'red', undone: 'gray',
};

const clock = (s: string) =>
  new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function Ledger({ entries, fail }: { entries: LedgerRow[]; fail: (e: unknown) => void }) {
  const rows = [...entries].sort((a, b) => b.seq - a.seq || Date.parse(b.at) - Date.parse(a.at));
  const undone = new Set(entries.map((e) => e.undoOf).filter(Boolean));
  return (
    <Stack h="100%" gap={0}>
      <Group px="md" pt="md" pb="sm" gap="xs">
        <IconBook2 size={20} />
        <Text fw={800}>Ledger</Text>
        <span className="live-dot" />
        <Text size="xs" c="dimmed" ml="auto">every tool call, as it happens</Text>
      </Group>
      <ScrollArea flex={1} px="md">
        {rows.length === 0 && <Text c="dimmed" size="sm" mt="sm">Nothing yet. Each tool call the agent makes, and each answer you give, lands here.</Text>}
        <Stack gap={8} pb="md">
          {rows.map((e) => (
            <Row key={e._id} e={e} canUndo={e.undoable && !undone.has(e._id) && e.outcome !== 'undone'} fail={fail} />
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

function Row({ e, canUndo, fail }: { e: LedgerRow; canUndo: boolean; fail: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const color = OUTCOME_COLOR[e.outcome] ?? 'gray';
  return (
    <Paper withBorder radius="md" className="ledger-row" style={{ borderLeft: `4px solid var(--mantine-color-${color}-6)` }}>
      <UnstyledButton w="100%" px="sm" py={8} onClick={() => setOpen(!open)}>
        <Group gap={8} wrap="nowrap">
          <Badge color={color} variant="light" radius="sm" size="md" w={92} style={{ flexShrink: 0 }}>{e.outcome}</Badge>
          <Text ff="monospace" size="sm" fw={700} truncate flex={1}>{e.action.replace(/^mcp__gateway__/, '')}</Text>
          <Text ff="monospace" size="xs" c="dimmed">{clock(e.at)}</Text>
        </Group>
        <Group gap={6} mt={4} wrap="nowrap">
          <Text size="xs" c="dimmed">{PROVIDER_LABEL[e.provider] ?? e.provider}</Text>
          {e.decidedBy && <Text size="xs" c="dimmed" truncate>· {cap(e.decidedBy)}</Text>}
          {canUndo && (
            <Button
              component="span"
              ml="auto"
              size="compact-xs"
              variant="light"
              leftSection={<IconArrowBackUp size={13} />}
              loading={busy}
              onClick={async (ev: React.MouseEvent) => {
                ev.stopPropagation(); setBusy(true);
                try { await api.undo(e._id); } catch (err) { fail(err); } finally { setBusy(false); }
              }}
            >
              Undo
            </Button>
          )}
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Box px="sm" pb="sm">
          <Table fz="xs" verticalSpacing={4} withRowBorders={false}>
            <Table.Tbody>
              <Table.Tr><Table.Th w={90}>Arguments</Table.Th><Table.Td><Code block>{pretty(e.args)}</Code></Table.Td></Table.Tr>
              <Table.Tr><Table.Th>Rule</Table.Th><Table.Td>{e.ruleId ?? '—'}</Table.Td></Table.Tr>
              <Table.Tr><Table.Th>Agent</Table.Th><Table.Td>v{e.agentVersion}</Table.Td></Table.Tr>
              <Table.Tr><Table.Th>Connection</Table.Th><Table.Td>{e.connectionId ?? '—'}</Table.Td></Table.Tr>
              {e.result !== undefined && e.result !== null && (
                <Table.Tr><Table.Th>Result</Table.Th><Table.Td><Code block mah={180} style={{ overflow: 'auto' }}>{pretty(e.result)}</Code></Table.Td></Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Box>
      </Collapse>
    </Paper>
  );
}
