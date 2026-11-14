// Looks at the live Composio project: auth configs, Slack tool slugs, a session's tools.
import { config } from 'dotenv';
import { Composio } from '@composio/core';
config({ quiet: true });

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false });

const acs = await composio.authConfigs.list({});
console.log('auth configs:', acs.items.map((a: any) => ({ id: a.id, toolkit: a.toolkit?.slug, managed: a.isComposioManaged, status: a.status })));

for (const q of ['send message', 'delete message', 'list channels']) {
  const tools = await composio.tools.getRawComposioTools({ toolkits: ['slack'], search: q, limit: 5 } as any);
  console.log(q, '→', tools.map((t: any) => t.slug));
}
const del = await composio.tools.getRawComposioTools({ tools: ['SLACK_SEND_MESSAGE'] } as any).catch((e) => String(e));
console.log('SLACK_SEND_MESSAGE', JSON.stringify((del as any)[0]?.inputParameters?.properties ?? del).slice(0, 600));

const session = await composio.create('probe_user', {
  toolkits: ['slack'],
  manageConnections: false,
  sandbox: { enable: false },
  proxyExecute: false,
} as any);
console.log('session', session.sessionId, JSON.stringify(session.config).slice(0, 800));
const raw = await composio.tools.getRawToolRouterSessionTools(session.sessionId);
for (const t of raw) console.log('tool', t.slug, JSON.stringify(t.inputParameters).slice(0, 400));
