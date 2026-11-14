// Compares the Slack permission screens of the default managed config and a
// narrow one (only what the demo uses). Starts a link for a throwaway user on
// each, follows it to Slack's authorize address and prints the scopes; then
// removes the throwaway links.
import { config } from 'dotenv';
import { Composio } from '@composio/core';
config({ quiet: true });

const NARROW_NAME = 'slack (demo scopes)';
const NARROW_SCOPES = ['channels:read', 'groups:read', 'chat:write'];
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false });

const list = await composio.authConfigs.list({ toolkit: 'slack' });
for (const a of list.items as any[]) console.log('config', a.id, JSON.stringify(a.name), 'connections', a.noOfConnections);
let narrow: any = (list.items as any[]).find((a) => a.name === NARROW_NAME);
if (!narrow && process.argv.includes('--create')) {
  narrow = await composio.authConfigs.create('slack', { type: 'use_composio_managed_auth', name: NARROW_NAME, credentials: { user_scopes: NARROW_SCOPES } });
  console.log('created', narrow.id);
}
const dflt: any = (list.items as any[]).find((a) => a.name !== NARROW_NAME);

async function slackUrl(authConfigId: string) {
  const req = await composio.connectedAccounts.link(`scope_probe_${Date.now()}`, authConfigId, { callbackUrl: 'http://localhost:4100/' });
  let url = req.redirectUrl!;
  for (let i = 0; i < 6 && !url.includes('slack.com'); i++) {
    const r = await fetch(url, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (!loc) {
      const html = await r.text();
      const m = html.match(/https:\/\/slack\.com\/oauth[^"'\s<]+/);
      url = m ? m[0].replace(/&amp;/g, '&') : `(no redirect; status ${r.status})`;
      break;
    }
    url = new URL(loc, url).toString();
  }
  await composio.connectedAccounts.delete(req.id).catch(() => {});
  return url;
}
for (const [label, cfg] of [['default', dflt], ['narrow', narrow]] as const) {
  if (!cfg) continue;
  const url = await slackUrl(cfg.id);
  if (!url.includes('slack.com')) { console.log(label, url); continue; }
  const u = new URL(url);
  const user = (u.searchParams.get('user_scope') ?? '').split(',').filter(Boolean);
  const bot = (u.searchParams.get('scope') ?? '').split(',').filter(Boolean);
  console.log(`${label}: ${user.length} user scopes, ${bot.length} bot scopes`);
  console.log('   user:', user.join(' '));
  if (bot.length) console.log('   bot:', bot.join(' '));
}
