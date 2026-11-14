import type { Hono } from 'hono';
import type { Db } from 'mongodb';
import type { ToolSource } from '../../shared/types.js';

// Placeholder until the app integrations are built.
export function createComposioSource(_db: Db): ToolSource | null {
  return null;
}

/** Adds the connection routes of docs/CONTRACT.md to the API. */
export function registerConnectionRoutes(_api: Hono, _db: Db): void {}
