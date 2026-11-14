# Codex: gateway-only tools — findings

Codex CLI 0.167.0 (`/opt/homebrew/bin/codex`), ChatGPT login, macOS. Measured
2026-11-14 with `probe.ts` (raw JSON-RPC client) and `mcpServer.ts` (one tool,
`notes_add`, held `HOLD_MS` before answering).

## Answer

**Yes, with one narrow limit.** With the launch flags below, the model has no
shell, no web, no account connectors and no plugin/user MCP servers. What is
left is the gateway's tools plus Codex's fixed helpers. File writes reach us as
approval requests that we decline. The limit: `apply_patch` cannot be removed
on this model, and it checks the patch against the real file *before* asking for
approval, so the model can test whether a given line exists in a local file
(yes/no only, no content returned).

## Launch

```
codex \
  -c notify=[] -c features.plugins=false -c features.hooks=false -c features.apps=false \
  -c features.shell_tool=false -c features.unified_exec=false -c features.view_image=false \
  -c features.image_generation=false -c features.multi_agent=false -c features.browser_use=false \
  -c features.computer_use=false -c features.in_app_browser=false -c features.tool_suggest=false \
  -c features.goals=false -c features.skill_search=false -c features.sleep_tool=false \
  -c 'web_search="disabled"' \
  app-server            # stdio JSON-RPC, one JSON object per line
```

`cwd` of the process: the conversation's empty scratch dir.
Nothing in `~/.codex` is edited; the login there is used as is. Threads are
saved under `~/.codex/sessions` (Codex's normal behaviour).

The user's own MCP servers from `config.toml` are switched off **per thread**,
by name, in the thread `config` (see below). Find them with
`codex -c features.plugins=false -c features.apps=false mcp list --json` and
keep the `enabled: true` ones. Two traps:
- `-c mcp_servers.<name>.enabled=false` on the command line fails
  (`invalid transport in mcp_servers.<name>`); the same key in the thread
  `config` works.
- Disabling a name that is not in the config (a plugin's server, when plugins
  are off) fails `thread/start` the same way. Only disable what the list says.

## JSON-RPC

1. `initialize` `{ clientInfo: {name,title,version}, capabilities: { experimentalApi: true } }`, then notification `initialized`.
2. `thread/start` (or `thread/resume` with `threadId` + the same params):
   ```json
   { "cwd": "<empty dir>", "sandbox": "read-only", "approvalPolicy": "on-request",
     "approvalsReviewer": "user",
     "developerInstructions": "<system prompt>",
     "config": { "mcp_servers": {
        "aside": {"enabled": false}, "node_repl": {"enabled": false}, "...": {},
        "gateway": { "url": "http://127.0.0.1:4100/mcp/<token>",
                     "tool_timeout_sec": 300, "startup_timeout_sec": 20,
                     "default_tools_approval_mode": "approve" } } } }
   ```
   `approvalsReviewer: "user"` matters: Miro's config sets `auto_review`, which
   would let a reviewer model decide instead of us.
   Result: `thread.id` (= session id), `model` (here `gpt-6.1-sol`, from the
   user's config), `reasoningEffort`. That is how the driver learns the model.
3. `turn/start` `{ threadId, input: [{ type: "text", text, text_elements: [] }] }` → `turn.id`.
   A second message in the same thread is just another `turn/start` after `turn/completed`.
4. `turn/interrupt` `{ threadId, turnId }` → `{}`, then `turn/completed` with
   `turn.status: "interrupted"`. A held MCP call gets no `item/completed`.
5. Resume after the process restarts: `thread/resume` `{ threadId, ...same params }`.
   Verified: the model remembered the interrupted earlier turn.

## Events used

- `turn/started` `{turn.id}`; `turn/completed` `{turn.status: completed|interrupted|failed, turn.error}`
- `item/agentMessage/delta` `{delta}` (text). Agent messages have `phase`
  `commentary` (mid-turn) or `final_answer`.
- `item/started` / `item/completed` with `item.type`:
  - `mcpToolCall` `{id, server, tool, arguments, status, result{content}, error{message}}`
  - `fileChange` `{changes[{path, kind, diff}], status: declined}`
  - `commandExecution` (never seen with the flags on)
- `error`, `mcpServer/startupStatus/updated` `{name, status: starting|ready|failed}`

Server → client requests and our answers:
- `item/commandExecution/requestApproval` → `{ decision: "decline" }`
- `item/fileChange/requestApproval` → `{ decision: "decline" }` (model sees "patch rejected by user")
- `mcpServer/elicitation/request` → accept only when `serverName === "gateway"` and
  `_meta.codex_approval_kind === "mcp_tool_call"`; otherwise decline. With
  `default_tools_approval_mode: "approve"` none arrived.
- `item/permissions/requestApproval` → grant nothing.
- anything else → JSON-RPC error.

## What the model can still do (flags on, read-only, empty cwd)

This model runs in "code mode": its tools are `exec` (a JS sandbox),
`wait`, `request_user_input` and `collaboration.*` (sub-agents). Inside `exec`,
`tools` has exactly:
`apply_patch`, `clock__curr_time`, `list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`, `mcp__gateway__<tool>`.

| Asked to | What happened |
| --- | --- |
| add a note | `mcpToolCall` gateway/notes_add, no approval prompt, result returned |
| run `ls` | no shell tool exists; model says it cannot |
| `fs`, `require`, `process`, `fetch`, `import("node:fs")` in exec | `ReferenceError` / "unsupported import in exec" |
| write `probe.txt` (apply_patch) | `item/fileChange/requestApproval` → declined, no file |
| write `/tmp/escape-probe.txt` | same, declined, no file |
| `read_mcp_resource` file:///etc/hosts | goes to **the gateway** (our server): "Method not found" |
| apply_patch Update on /etc/hosts, wrong line | "Failed to find expected lines in /etc/hosts: <our own line>" (no content) |
| apply_patch Delete /etc/hosts | approval request → declined. The `fileChange` item sent **to the driver** carries the full file as `diff`; the model only sees "patch rejected by user" |

Without the flags (baseline), the same thread had `exec_command` and ran
`/bin/zsh -lc 'ls -la /etc/hosts'` in the read-only sandbox **with no
approval request**, plus the account's connector tools. The flags are what
make it gateway-only.

## Limits

1. `apply_patch` stays (model-defined; `include_apply_patch_tool=false` and
   `tools.apply_patch=false` do nothing). Every patch is declined, but its
   pre-check is a yes/no oracle on lines in files the user can read.
2. The driver must never forward a `fileChange` item's `diff` to the model or
   the page: for Update/Delete it contains the real file.
3. `list_mcp_resources` / `read_mcp_resource` go to the gateway. The gateway
   must not offer resources (or must check them like tools).
4. `collaboration.*` sub-agents and `request_user_input` remain
   (`features.multi_agent=false`, `multi_agent_v2=false` do not remove them).
   Not tested: whether a sub-agent inherits the thread's gateway-only config.
   `item/tool/requestUserInput` reaches the driver, which refuses it.
5. Tool timeout: `tool_timeout_sec: 300` per server; a 90 s hold completed.
   The default would cut a 4-minute hold.
6. The model comes from the user's config unless `model` is passed.
