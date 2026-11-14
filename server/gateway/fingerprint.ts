import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level, so equal args hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Names one action with these exact arguments. Never includes the provider. */
export function fingerprint(action: string, args: unknown): string {
  const hash = createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 16);
  return `${action}:${hash}`;
}
