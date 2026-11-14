// Apps connected to agents through Composio: the connect routes and the tool source.
import type { Hono } from 'hono';
import type { Db } from 'mongodb';
import { composioClient, createSource, type ComposioSource } from './composio.js';
import { registerConnectionRoutes as register } from './routes.js';

export { kindOf, summarize, undoable } from './composio.js';
export type { ComposioSource } from './composio.js';

/** The `composio` tool source; null when COMPOSIO_API_KEY is missing. */
export function createComposioSource(db: Db): ComposioSource | null {
  const composio = composioClient();
  if (!composio) {
    console.warn('COMPOSIO_API_KEY is not set: connected apps are off.');
    return null;
  }
  return createSource(db, composio);
}

/** Adds the connection routes of docs/CONTRACT.md to the API (mounted at /api). */
export function registerConnectionRoutes(api: Hono, db: Db): void {
  register(api, db);
}
