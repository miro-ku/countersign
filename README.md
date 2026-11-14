# Countersign

Custom agents whose rules hold whatever runs them.

Built at the MongoDB Toronto Hackathon on November 14, 2026, for the problem
statement **Agents You Can Audit**. Everything in this repository was written
during the event.

## The problem

Teams want agents that act on real systems. Two things stop them:

- Nobody can say afterwards who allowed an action.
- The permission rules live inside one vendor's agent, so they disappear the
  day the team changes models.

## What it does

1. You create an agent: a name, instructions and an engine.
2. You connect your own apps to it (Slack, Gmail). The connection is the grant
   of authority: it is recorded with who gave it, and it can be revoked.
3. You talk to the agent on one page, by text or on a live voice call.
4. The agent runs on Claude Code or on Codex, and you can switch between them
   in the middle of a conversation.
5. Every action goes through one gateway. It is checked against rules before
   it runs, held while you are asked, and recorded in a ledger.
6. A decision belongs to the agent, not to the engine. Reject an action on one
   engine, switch to the other, ask again: it is refused without asking.

## How it works

```
page ──► API ──► conversation engine ──► Claude Code │ Codex
                                              │  (no tools of their own)
                                              ▼
                                           gateway ──► rules, decisions
                                              │   └──► ask the person, hold the call
                                              ▼
                                      the action runs ──► ledger
```

- **The gateway is the agent's only source of tools.** The engines' own shell,
  file and web tools are off. A call is unpacked into single actions; each gets
  a fingerprint (its name and a hash of its exact arguments) and a verdict:
  allow, deny, or ask. Nothing in a call runs unless every action is allowed.
- **An action that needs approval is held open.** The answer is a write to the
  database, and a change stream releases the held call.
- **The conversation lives in the database.** Messages are the source of
  truth, each stamped with the engine that wrote it. Each engine keeps a
  pointer and a watermark on the conversation, so switching means reading what
  that engine has not seen yet.
- **On a call, the spoken answer is judged separately** as yes, no or unclear.
  Unclear is never a yes.

## How it uses MongoDB Atlas

Atlas is the identity, policy, audit and conversation layer.

| Feature | Use |
| --- | --- |
| Collections | `agents`, `connections` (the grants), `rules`, `conversations`, `messages`, `executions`, `asks`, `decisions`, `ledger` |
| Schema validation | Every collection has a `$jsonSchema` validator: the database refuses a rule without a reason, a connection without an owner, a ledger entry without the person, agent, version and engine |
| Change streams | An answer releases the held tool call; a revoked connection reaches the running agent; the page's chat and ledger are fed live |
| Unique indexes | One decision per action per conversation, whichever engine asks; one open request per action |
| Atomic updates | One answer wins when a request is answered |
| Append-only ledger | Ledger entries are only ever inserted |

The full agreement between the parts is in [docs/CONTRACT.md](docs/CONTRACT.md).

## Run it

Needs Node 24, pnpm 10, the `claude` and `codex` command-line tools signed in on the
machine, and a MongoDB Atlas cluster.

```sh
cp .env.example .env        # fill in the values
pnpm install                # one install for the server, the page and the voice service
pnpm setup:db               # collections, validators, indexes, default rules
pnpm dev                    # API and gateway on 4100, page on 5173
```

Then open http://localhost:5173.

`pnpm exec tsx scripts/smoke.ts` runs the governed path end to end against a running
server; `--switch` also checks that a rejection holds after changing engines.

## Layout

| Path | What |
| --- | --- |
| `server/` | API, conversation engine, gateway, engine drivers, app connections |
| `web/` | The page: a chat with a live ledger beside it |
| `voice/` | The live call and the answer judge |
| `shared/` | Types shared by every part |
| `scripts/` | The end-to-end check |
| `spikes/` | Throwaway checks made along the way |
