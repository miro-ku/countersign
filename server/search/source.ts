// Two read tools that let an agent look up its own past: what it did, when,
// for whom and on whose approval. The agent comes from the call, never from
// the model's input, so an agent can only ever read its own record.
import type { Db } from 'mongodb';
import type { Action, ToolSource } from '../../shared/types.js';
import { explain } from './explain.js';
import { searchRecord } from './query.js';

export const RECORD_TOOLS = ['record_search', 'record_explain'];

/** The line the server adds to the agent's system prompt. */
export const RECORD_PROMPT_LINE =
  'You have a record of your own past conversations and actions. When someone asks what you did, when, or why, look it up with record_search and record_explain before answering, and say who asked for it and who approved it.';

export function isRecordTool(name: string): boolean {
  return RECORD_TOOLS.includes(name);
}

export function createRecordSource(db: Db): ToolSource {
  return {
    id: 'record',

    async tools() {
      return [
        {
          name: 'record_search',
          description:
            'Search your own past actions and conversations (all of them, not only this one) by meaning. ' +
            'Returns the best matches, each with its id, what it is, a one-sentence description, when it happened, ' +
            'its conversation and, for an action, its outcome. Use record_explain on an id for the full story.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to look for, in plain words: "the refund message posted to Slack".' },
              limit: { type: 'number', description: 'How many matches, 1 to 20. Default 8.' },
            },
            required: ['query'],
          },
        },
        {
          name: 'record_explain',
          description:
            'The full story of one past action (or message) by its id from record_search: the request that started it, ' +
            'the approval asked and who answered and how, the rule, the provider and model, the connection used, ' +
            'the result, and whether it was undone. Repeat these facts; do not guess beyond them.',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'The id of an action or message from record_search.' } },
            required: ['id'],
          },
        },
      ];
    },

    actionsOf(tool, input): Action[] | null {
      const i = (input ?? {}) as Record<string, unknown>;
      if (tool === 'record_search') {
        const query = String(i.query ?? '');
        const args = i.limit === undefined ? { query } : { query, limit: Number(i.limit) };
        return [{ name: 'record_search', kind: 'read', args, summary: `search its own record for "${query}"` }];
      }
      if (tool === 'record_explain') {
        const id = String(i.id ?? '');
        return [{ name: 'record_explain', kind: 'read', args: { id }, summary: `look up the story of ${id}` }];
      }
      return null;
    },

    async run(tool, input, ctx) {
      const i = (input ?? {}) as Record<string, unknown>;
      if (tool === 'record_search') {
        const limit = Math.min(Math.max(Number(i.limit ?? 8) || 8, 1), 20);
        const hits = await searchRecord(db, ctx.agentId, String(i.query ?? ''), { limit, minScore: 0.6 });
        if (!hits.length) return { matches: [], note: 'Nothing in your record matches that.' };
        return {
          matches: hits.map((h) => ({
            id: h.id,
            what: h.kind === 'action' ? `action ${h.action}` : h.role === 'user' ? "the person's message" : 'your reply',
            text: h.text,
            when: h.when,
            at: h.at,
            conversationId: h.conversationId,
            thisConversation: h.conversationId === ctx.conversationId,
            ...(h.outcome ? { outcome: h.outcome } : {}),
          })),
        };
      }
      if (tool === 'record_explain') return explain(db, ctx.agentId, String(i.id ?? ''));
      throw new Error(`${tool} is not a record tool.`);
    },
  };
}
