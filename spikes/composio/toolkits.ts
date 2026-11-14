// Prints, for a few apps, what Composio offers: logo, auth schemes, managed auth.
import 'dotenv/config';
import { Composio } from '@composio/core';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY!, allowTracking: false });
for (const slug of ['slack', 'gmail', 'stripe', 'github', 'notion', 'googlecalendar', 'linear', 'hubspot']) {
  try {
    const t: any = await composio.toolkits.get(slug);
    console.log(slug, JSON.stringify({
      name: t.name, logo: t.meta?.logo, schemes: t.authConfigDetails?.map((a: any) => a.mode) ?? t.authSchemes,
      managed: t.composioManagedAuthSchemes, tools: t.meta?.toolsCount,
    }));
  } catch (err) {
    console.log(slug, 'ERROR', (err as Error).message.slice(0, 120));
  }
}
