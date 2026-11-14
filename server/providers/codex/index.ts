import type { ProviderDriver } from '../../../shared/types.js';

// Placeholder until the Codex driver is built.
export const codexDriver: ProviderDriver = {
  name: 'codex',
  async start() {
    throw new Error('The Codex driver is not built yet.');
  },
};
