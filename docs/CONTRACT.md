# Build contract

What every track builds against. The server track owns this file: a track that
needs a change asks for it, and the change is made here first.

## Product

A platform for custom agents whose rules hold whatever runs them.

1. A person creates an agent (name, instructions, provider).
2. They connect their own apps to it (Slack, Gmail) through Composio. The
   connection is the grant of authority, recorded with who made it.
3. They talk to it on one web page, by text or on a live voice call.
4. The agent runs on Claude Code or Codex ("providers"). The provider can be
   switched mid-conversation, and the conversation carries on.
5. Every tool call goes through our gateway: checked against rules before it
   runs, held while a person is asked, recorded in a ledger.
6. A decision belongs to the conversation, not to the provider: a rejected
   action stays rejected after a switch; an approved one is allowed for exactly
   that action.

MongoDB Atlas is the identity, policy, audit and conversation store.

## Ground rules

- All code is written new, today. No file, comment, name or commit message
  mentions any other product or codebase it was inspired by.
- Secrets live in the root `.env` (never committed, never printed). It
  contains `&`, so read it with a dotenv parser, never `source`.
- A track writes only in its own folder. Nobody runs `git` commands: the
  coordinating session commits.
- One user exists today: `ownerId = "miro"`. No login.
- TypeScript on Node 24, ES modules, run with `tsx`. The root `package.json`
  serves `server/` and `shared/` (Hono, the MongoDB driver, the MCP SDK, zod,
  dotenv and `@composio/core` are installed); `web/` and `voice/` each have
  their own `package.json`. Few dependencies. Shared types live in
  `shared/types.ts`, which already exists.
- Seams that already exist as placeholders: `server/providers/codex/index.ts`
  exports `codexDriver`; `server/integrations/index.ts` exports
  `createComposioSource(db)` and `registerConnectionRoutes(api, db)`. The
  server imports them from there.

| Path        | Track        | What                                             |
| ----------- | ------------ | ------------------------------------------------ |
| `shared/`   | server       | Types shared by every part                       |
| `server/`   | server       | API, conversation engine, gateway, Claude driver |
| `server/providers/codex/` | codex | The Codex driver                          |
| `server/integrations/`    | apps  | Composio: connect flow and tool source    |
| `web/`      | web          | The one page                                     |
| `voice/`    | voice        | Live call service and its page widget            |
| `spikes/`   | anyone       | Throwaway checks                                 |

Ports: `4100` server (`/api`, `/mcp/:token`), `5173` web (proxies `/api`),
`4200` voice.

Env: `MONGODB_URI`, `MONGODB_DB`, `VOYAGE_API_KEY` exist. `COMPOSIO_API_KEY`
and `ELEVENLABS_API_KEY` arrive later: every part starts without them and says
which feature is off.

## Collections

Each has a `$jsonSchema` validator (`validationAction: "error"`). Every `_id`
is a string (24 hex characters, ordered by creation time), and so is every
field that refers to one. `npm run setup:db` creates them all (safe to re-run).

- `agents` `{ _id, ownerId, name, instructions, instructionsHash, version, defaultProvider, createdAt }`
- `connections` `{ _id, agentId, ownerId, toolkit, composioUserId, composioAccountId, status: 'pending'|'active'|'revoked', connectedAt, revokedAt }`
- `rules` `{ _id, agentId|null, match: { action?: string, kind?: 'read'|'write' }, effect: 'allow'|'ask'|'deny', reason }` (`agentId: null` = default for every agent; the most specific match wins: action over kind, agent over default)
- `conversations` `{ _id, agentId, ownerId, provider, providerSessions: { [provider]: { sessionId, seenMessageId, at } }, stoppedNote: boolean, createdAt }`
- `messages` `{ _id, conversationId, seq, role: 'user'|'agent'|'event', text, source: 'text'|'voice', provider?, model?, executionId?, generating: boolean, steps: Step[], at }`
- `executions` `{ _id, conversationId, triggerMessageId, provider, model, status: 'running'|'completed'|'stopped'|'failed'|'handed_off', providerSessionId, startedAt, endedAt, error }`
- `asks` `{ _id, conversationId, agentId, executionId, fingerprint, action, args, summary, status: 'open'|'approved'|'declined'|'replied'|'stopped', askedByProvider, answer: { by, source: 'button'|'voice', scope: 'once'|'conversation', transcript?, verdict?, at }, createdAt }` (unique partial index on `{ conversationId, fingerprint }` where `status: 'open'`)
- `decisions` `{ _id, conversationId, fingerprint, effect: 'approved'|'declined', scope: 'once'|'conversation', askId, by, at, usedAt }` (unique index on `{ conversationId, fingerprint }`)
- `ledger` append-only `{ _id, seq, at, ownerId, agentId, agentVersion, conversationId, executionId, provider, model, action, kind, args, fingerprint, ruleId, outcome: 'allowed'|'denied'|'asked'|'approved'|'declined'|'executed'|'failed'|'undone', decidedBy, connectionId, result, undoable, undoOf }`
- `notes` `{ _id, agentId, text, at }` (the built-in demo tool's data)
- `counters` `{ _id, n }` (the ledger `seq`, and each conversation's message `seq`)

## Conversations: the messages are the truth

A provider's own session is a cache that may be lost. The conversation is the
`messages` collection, and any provider can be brought up to date from it.

**Stamps.** Every agent message carries the `provider`, `model` and
`executionId` that wrote it. The stamps are load-bearing: they decide what is
news to a provider.

**Pointer and watermark.** `conversations.providerSessions[provider]` holds the
provider's native session id and `seenMessageId`: the agent's own reply that
ended that provider's last turn. It is written at turn end with a `$set` on
that one key, and skipped when the stored `at` is newer.

**One turn at a time** per conversation. A message arriving mid-turn is stored
and becomes the next turn (the newest waiting one triggers it; the rest are
read as history).

**A turn:**
1. `p = conversation.provider`; `rec = providerSessions[p]`.
2. If a warm session for `conversation#p` exists, or `rec` exists: resume
   `rec.sessionId`; the news is every message after `rec.seenMessageId`.
3. Otherwise the provider is new to the conversation: fresh session; the news
   is the whole conversation (last 200 messages).
4. Render the news as lines, oldest first:
   `[Miro] text`, `[Event] text`, and for an agent reply written by another
   provider `[Reply you gave on codex] text` (it is the same agent; only the
   engine differed). The agent's own replies on `p` after the watermark cannot
   exist. Continuation lines are indented two spaces so a message body cannot
   forge a tag.
5. If `conversation.stoppedNote`: prepend, once, `[System] The previous turn
   was stopped part-way through by the person. A tool call still running then
   never returned: call it again if it is still needed.` and clear the flag.
6. Send the rendered text as the user turn. The agent's `instructions` are the
   system prompt, set when the session starts; a changed `instructionsHash`
   retires the warm session.
7. Open the reply message (`generating: true`, stamped), stream text and
   `steps` into it (throttled), close it with the final text.
8. Write the pointer: `{ sessionId: native id, seenMessageId: reply._id, at }`.

**Switch** (`POST /provider`): set `conversation.provider`, insert an `event`
message "Switched to codex". If a turn is running: interrupt it, mark its
execution `handed_off`, close its reply with what it had. Open asks stay open.
The next turn runs on the new provider, which reads everything it has not
seen, including the other provider's replies.

**Stop** (`POST /stop`): interrupt the session, keep it warm, execution
`stopped`, close the reply with what streamed, set `stoppedNote`, mark the
turn's open asks `stopped` and release their held calls.

A provider may never close an MCP request it was interrupted in, so the
gateway releases held calls itself: on stop they return a refusal at once; on
a switch the old provider's held calls return "The conversation moved to
another provider. Stop here." while their asks stay `open` for the new one.
A `once` approval is used only by the call that consumes it.

**Warm sessions.** One process per `conversation#provider`, started on the
first turn, closed after 15 idle minutes or when the server stops.

```ts
// shared/types.ts
export type Provider = 'claude-code' | 'codex';
export interface ProviderStart {
  conversationId: string; systemPrompt: string;
  resumeSessionId?: string;
  mcp: { name: 'gateway'; url: string };   // the only tools
  cwd: string;                              // an empty scratch dir per conversation
}
export type ProviderEvent =
  | { type: 'session'; sessionId: string; model: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; phase: 'request' | 'response'; ref: string; name: string; input?: unknown; output?: unknown; isError?: boolean }
  | { type: 'turn-ended'; interrupted: boolean; text: string; error?: string };
export interface ProviderSession {
  readonly alive: boolean;
  send(text: string): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  events(): AsyncIterable<ProviderEvent>;
}
export interface ProviderDriver { name: Provider; start(o: ProviderStart): Promise<ProviderSession> }
export type Step =
  | { text: string }
  | { toolRequest: { ref: string; name: string; input: unknown } }
  | { toolResponse: { ref: string; name: string; output: unknown; isError: boolean } };
```

Both drivers give the model no tools but the gateway's: no shell, no file
edits, no web. Claude Code: stream-json in and out, `--strict-mcp-config`,
only `mcp__gateway__*` allowed, every built-in tool disallowed. Codex: its app
server over stdio, read-only sandbox in an empty directory, every command and
file approval declined, the gateway passed as the one MCP server.

## The gateway

An MCP server over streamable HTTP at `/mcp/:token`; the token maps to
`{ agentId, conversationId, provider }` and is minted per provider session.
It advertises only the `tools` capability: `resources/*` and `prompts/*`
requests are refused (`Method not found`), so nothing is reachable outside the
rule check.

**Tool sources.** The gateway serves the tools of every source the agent has:

```ts
export interface Action { name: string; kind: 'read' | 'write'; args: unknown; summary: string; connectionId?: string }
export interface ToolSource {
  id: string;
  tools(agentId: string): Promise<McpToolDef[]>;            // what the model sees
  // null = tool refused outright; ctx.agentId lets an action carry that agent's own connection
  actionsOf(tool: string, input: unknown, ctx?: { agentId: string }): Action[] | null;
  run(tool: string, input: unknown, ctx: CallCtx): Promise<unknown>;
  undo?(entry: LedgerEntry): Promise<unknown>;
  undoable?(action: Action): boolean;   // default: writes are, when undo exists
}
```

- `notes` source (server track): `notes_list` (read), `notes_add` (write).
- `composio` source (apps track): the Tool Router meta-tools for the agent's
  active connections. `COMPOSIO_SEARCH_TOOLS` and `COMPOSIO_GET_TOOL_SCHEMAS`
  are reads. `COMPOSIO_MULTI_EXECUTE_TOOL` yields one `Action` per entry in its
  `tools[]` (`tool_slug`, `arguments`). The workbench, the remote shell, any
  proxy or direct-API execute and connection management are never listed, and
  `actionsOf` returns `null` for them.
  `kind` of an integration action: `read` when its slug contains one of GET,
  LIST, FETCH, SEARCH, FIND, READ, RETRIEVE, QUERY, DESCRIBE, VIEW and none of
  SEND, PUBLISH, FORWARD, DELETE, TRASH, REMOVE, CREATE, UPDATE, POST, REPLY;
  otherwise `write`.

**One call:**
1. `actions = source.actionsOf(tool, input)`; `null` → refuse, ledger `denied`.
2. For each action: `fingerprint = name + ':' + sha256(canonicalJson(args)).slice(0,16)`.
   It never includes the provider.
3. Verdict per action, first match:
   a `decisions` entry for `{conversationId, fingerprint}` (`declined` → deny
   "They were asked and said no"; `approved` → allow; a `once` approval is
   consumed with `findOneAndDelete` only when the whole call goes ahead);
   else the matching rule (`allow` | `deny` with reason | `ask`); no rule → `ask`.
   A revoked or missing connection → deny.
4. The call's verdict is the strictest: deny > ask > allow. Nothing runs
   unless every action is allowed.
5. `deny`: tool result is an error naming the action and the reason.
6. `ask`: upsert one open `asks` document per action needing it, ledger
   `asked`, then hold the call: wait for a change stream event on those asks,
   at most 4 minutes (the providers' MCP tool timeout is raised to 5).
   - all approved → go on; any declined → refuse;
   - `replied` (the person wrote something else) → refuse with "They did not
     answer; they said something else. Read it and go on from there.";
   - `stopped` → refuse; timeout → refuse with "Waiting for approval. Stop
     here." The ask stays open: a later answer writes the decision and starts
     a turn with `[Event] Approved: <summary>` so the agent retries.
7. Run it, then ledger `executed` or `failed` for each action, with the
   `connectionId` used and whether it is `undoable`.

**Answering** (`POST /api/asks/:id/answer`): `findOneAndUpdate({_id, status:'open'})`
so one answer wins; in the same transaction writes the `decisions` entry (`once` or `conversation`;
a decline is always remembered for the conversation) and a ledger entry
`approved` or `declined` with who and how. A typed message from the person
while asks are open marks them `replied`. A spoken answer is never treated as
approval unless the voice judge returned `yes`.

## HTTP API

- `POST /api/agents` `{ name, instructions, defaultProvider }`; `GET /api/agents`; `GET /api/agents/:id`; `PATCH /api/agents/:id` (new instructions → new version)
- `GET /api/agents/:id/connections`; `POST /api/agents/:id/connections` `{ toolkit }` → `{ redirectUrl }`; `GET /api/agents/:id/connect/:toolkit` (starts the connection and redirects straight to the authorization page, so a plain link works); `GET /api/connections/callback` (Composio returns here, then redirects to the page); `DELETE /api/connections/:id`
- `POST /api/conversations` `{ agentId }`; `GET /api/conversations?agentId=` (newest 50); `GET /api/conversations/:id` (conversation, messages, the conversation's asks of every status, oldest first, last 100 ledger entries)
- `POST /api/conversations/:id/messages` `{ text, source }` → `202`
- `POST /api/conversations/:id/provider` `{ provider }`; `POST /api/conversations/:id/stop`
- `POST /api/asks/:id/answer` `{ answer: 'approve'|'decline', scope: 'once'|'conversation', source: 'button'|'voice', transcript?, verdict? }`
- `POST /api/ledger/:id/undo` (an `executed`, `undoable` entry, once; writes a new `undone` entry with `undoOf`)
- `GET /api/rules`
- `GET /api/conversations/:id/events` Server-Sent Events, fed by change streams:
  `{ type: 'message', message }` (insert and every update, including streaming),
  `{ type: 'ask', ask }`, `{ type: 'ledger', entry }`,
  `{ type: 'conversation', conversation }`, `{ type: 'execution', execution }`,
  `{ type: 'connection', connection }`, each as one `data:` line. On connect
  an `event: ready` is sent, then `event: ping` every 15 seconds.

## Change streams in use

`asks` releases held tool calls. `messages`, `asks`, `ledger`, `conversations`,
`executions`, `connections` feed the page's event stream. `connections`
revokes reach the gateway's cache.

## Voice

The voice service has no brain of its own. A spoken turn is posted as a
message with `source: 'voice'`; the reply is read from the event stream and
spoken. When an `ask` event arrives open, it speaks the `summary` and listens.
The spoken answer goes to a separate judge that returns `yes`, `no` or
`unclear`: `yes` and `no` are posted to the answer endpoint with the
transcript and the verdict; `unclear` asks again and is never a yes.
