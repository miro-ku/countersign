// The built-in demo tool: a notebook per agent.
import type { Action, LedgerEntry, ToolSource } from '../../shared/types.js';
import { col, newId } from '../db.js';

export const notesSource: ToolSource = {
  id: 'notes',

  async tools() {
    return [
      {
        name: 'notes_list',
        description: "List the agent's notes.",
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'notes_add',
        description: 'Add a note.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The text of the note.' } },
          required: ['text'],
        },
      },
    ];
  },

  actionsOf(tool, input): Action[] | null {
    if (tool === 'notes_list') {
      return [{ name: 'notes_list', kind: 'read', args: {}, summary: 'read the notes' }];
    }
    if (tool === 'notes_add') {
      const text = String((input as { text?: unknown })?.text ?? '');
      return [{ name: 'notes_add', kind: 'write', args: { text }, summary: `add a note saying "${text}"` }];
    }
    return null;
  },

  async run(tool, input, ctx) {
    if (tool === 'notes_list') {
      const notes = await col.notes.find({ agentId: ctx.agentId }).sort({ at: 1 }).toArray();
      return notes.map((n) => ({ id: n._id, text: n.text, at: n.at }));
    }
    const text = String((input as { text?: unknown })?.text ?? '');
    const note = { _id: newId(), agentId: ctx.agentId, text, at: new Date() };
    await col.notes.insertOne(note);
    return { id: note._id, text };
  },

  async undo(entry: LedgerEntry) {
    const noteId = (entry.result as { id?: string } | undefined)?.id;
    if (!noteId) throw new Error('This entry has no note to remove.');
    const removed = await col.notes.deleteOne({ _id: noteId });
    return { removed: removed.deletedCount === 1, id: noteId };
  },
};

export function isNotesTool(name: string): boolean {
  return name === 'notes_list' || name === 'notes_add';
}
