// Prints the argument names of the slugs the summaries and undo depend on.
import { config } from 'dotenv';
import { Composio } from '@composio/core';
config({ quiet: true });
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false });
for (const slug of ['SLACK_SEND_MESSAGE', 'SLACK_DELETES_A_MESSAGE_FROM_A_CHAT', 'GMAIL_SEND_EMAIL', 'SLACK_LIST_ALL_CHANNELS']) {
  const t: any = await composio.tools.getRawComposioToolBySlug(slug);
  console.log(slug, 'required', t.inputParameters?.required, 'props', Object.keys(t.inputParameters?.properties ?? {}));
  console.log('  output', JSON.stringify(t.outputParameters?.properties?.data?.properties ? Object.keys(t.outputParameters.properties.data.properties) : t.outputParameters).slice(0, 300));
}
