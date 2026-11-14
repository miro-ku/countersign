# Proviso

Custom agents whose rules hold whatever runs them.

Built at the MongoDB Toronto Hackathon on November 14, 2026, for the problem
statement **Agents You Can Audit**. Everything in this repository was written
during the event, by one person working with coding agents.

## The problem

Teams want agents that act on real systems. Two things stop them:

- Nobody can say afterwards who allowed an action.
- The permission rules live inside one vendor's agent, so they disappear the
  day the team changes models.

## What it does

1. You create an agent: a name, instructions and an engine.
2. You connect your own apps to it. The connection is the grant of authority:
   it is recorded with who gave it, and it can be taken back.
3. You talk to the agent on one page, by typing or on a live voice call.
4. The agent runs on Claude Code or on Codex, and you can switch between them
   in the middle of a conversation. It stays one agent with one memory.
5. Every action goes through one gateway. It is checked against rules before
   it runs, held while you are asked, and recorded in a ledger.
6. A decision belongs to the agent, not to the engine. Reject an action on one
   engine and the other engine is refused the same action without asking.
7. The agent can explain itself: asked "why did we refund Acme?", it looks up
   its own record and says who asked, who approved and when.

## The example it was built around

A billing support agent with Stripe and Slack connected, and a playbook in its
instructions: when a customer was charged twice, refund the duplicate, add a
goodwill credit, tell the team.

Told "Acme says they were charged twice in October", it reads Stripe without
asking, then proposes each step and waits: the refund, the credit, the Slack
post. A refund of 100.00 or more is blocked by a rule and nobody is asked. On a
call the approvals are spoken, and "hmm, I'm not sure" is not a yes.

## How it works

```
page / call ──► API ──► conversation engine ──► Claude Code │ Codex
                                                     │  (no tools of their own)
                                                     ▼
                                                  gateway ──► rules, decisions
                                                     │   └──► ask the person, hold the call
                                                     ▼
                                             the action runs ──► ledger
```

- **The gateway is the agent's only source of tools.** The engines' own shell,
  file and web tools are off. A call is unpacked into single actions; nothing
  in a call runs unless every action is allowed.
- **Rules are documents, read on every call.** A rule allows, asks or denies.
  The defaults: reading is allowed, changes ask, card numbers are never sent,
  channels are never deleted, a refund of 100.00 or more is never made. A deny
  rule cannot be overridden by an approval.
- **You can add a rule in plain words.** A sentence about amounts or names
  becomes an exact test on the action's own fields. A sentence about meaning
  ("never promise a customer a delivery date") is read against each action by
  a small judging model. The judge can only make things stricter: it can ask
  or deny, never allow.
- **An action has one identity whichever engine words it.** A refund is the
  charge and the amount; a Slack post is the channel and the text. One engine
  naming the charge and the other naming the payment is the same refund.
- **An action that needs approval is held open.** The answer is a write to the
  database, and a change stream releases the held call.
- **The conversation lives in the database.** Messages are the source of
  truth, each stamped with the engine that wrote it. Each engine keeps a
  pointer and a watermark, so switching means reading what it has not seen.
- **On a call the microphone is a switch,** or the space bar held down: on to
  speak, off to send. The whole turn is then transcribed once more with the
  names worth listening for. A spoken answer to an approval
  goes to a separate judge that returns yes, no or unclear, and unclear is
  never a yes.

## How it uses MongoDB Atlas

Atlas is the identity, policy, audit and conversation layer.

| Feature | Use |
| --- | --- |
| Collections | `agents` (versioned), `connections` (the grants), `rules`, `conversations`, `messages`, `executions`, `asks`, `decisions`, `ledger`, `record` |
| Schema validation | Every collection has a `$jsonSchema` validator: a ledger entry without the person, agent, version and engine is refused by the database |
| Change streams | An answer releases the held tool call; the page's chat and ledger are fed live; a worker follows the ledger and messages to keep the agent's record |
| Unique indexes | One decision per action per conversation, whichever engine asks; one open request per action; one running turn per conversation |
| Transactions | An answer and the decision it makes are written together, so one answer wins |
| Roles | The server runs as a database user whose custom role can insert into the ledger and read it, and cannot update or delete it. `scripts/ledgerProof.ts` shows Atlas refusing each attempt |
| Vector Search | The agent's record of its own actions and messages is embedded by Atlas itself (automated embedding, a Voyage model) and searched by meaning, always filtered to one agent |

The agreement the parts were built against is in [docs/CONTRACT.md](docs/CONTRACT.md).

## Run it

Needs Node 24, pnpm 10, the `claude` and `codex` command-line tools signed in
on the machine, a MongoDB Atlas cluster, and keys for Composio and ElevenLabs.
The call also needs a LiveKit server (`livekit-server --dev`).

```sh
cp .env.example .env        # fill in the values
pnpm install
pnpm setup:db               # collections, validators, indexes, default rules
pnpm dev                    # API and gateway on 4100, page on 5173
pnpm --dir voice start      # the call, on 4200
```

Then open http://localhost:5173.

| Script | What it does |
| --- | --- |
| `pnpm exec tsx scripts/smoke.ts --switch` | The governed path end to end, including a rejection that holds after changing engines |
| `pnpm exec tsx scripts/ledgerProof.ts` | Shows the database refusing to change the ledger |
| `pnpm exec tsx scripts/seedStripe.ts --fresh` | The example's customers and payments, in a Stripe test account only |
| `pnpm reset --yes` | Empties the data and keeps the default rules |

## What is proven, and what is not

- **Engines:** Claude Code and Codex run in the product. GitHub Copilot and
  Kiro were shown to work through the same driver contract in a test
  (`spikes/engines/`), and are not wired into the page.
- **Apps:** Slack and Stripe were used end to end. The page also offers
  Gmail, GitHub, Notion, Google Calendar, Linear and HubSpot through Composio;
  those were not exercised.
- **Words and identity:** an action's plain-words description and its
  engine-independent identity are written for Slack posts, refunds and
  credits. Other actions are described generically and compared by their
  exact arguments, so a rejection may be asked about again on another engine.
- **Undo** exists for a posted Slack message only.
- **Codex** keeps a patch tool that cannot be switched off. Every patch is
  declined, but its failure can reveal whether a line exists in a local file.
- **One person:** there is no sign-in; every action is recorded for one user.

## Layout

| Path | What |
| --- | --- |
| `server/` | API, conversation engine, gateway, engine drivers, app connections, the agent's record |
| `web/` | The page: a chat with a live ledger beside it |
| `voice/` | The call, the transcription and the answer judge |
| `shared/` | Types shared by every part |
| `scripts/` | Checks, the proof, seeding and reset |
| `spikes/` | Throwaway checks made along the way |
