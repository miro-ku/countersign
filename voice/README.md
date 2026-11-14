# Voice

The live call. The person talks to the agent in a LiveKit room; this service
joins the same room as the agent's voice. It has no brain of its own: what the
person says is posted to the server's API as a message with `source: 'voice'`,
and the agent's reply is read from the event stream and spoken sentence by
sentence. Talking over the agent stops it.

When a tool call is held for approval (an open `ask`), the service says
"I need your approval to …. Do you approve?" and sends the next thing the person
says to the **judge**: one call to a small model (`claude -p --model haiku`, no
tools, no settings, no session) given only the request's summary and the
transcript, answering strictly `yes`, `no` or `unclear`. `yes` and `no` are
posted to `POST /api/asks/:id/answer` with `source: 'voice'`, the transcript and
the verdict. `unclear` asks once more, then leaves the ask open for the button.
Anything that is not exactly `yes` counts as not approved.

## Run

```sh
livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1   # LiveKit, dev keys
cd voice && npm start                                       # this service, :4200
```

Env (root `.env`): `ELEVENLABS_API_KEY` (without it, voice is off and `/token`
says so). Optional: `VOICE_API_BASE` (default `http://localhost:4100`),
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (default the dev ones),
`ELEVENLABS_VOICE_ID`, `VOICE_ORIGINS` (default `http://localhost:5173`).

## Endpoints

- `GET /token?conversationId=…` → `{ url, token, room }`; the agent joins the room.
- `GET /widget.js` — the page widget. `GET /test.html?c=<conversationId>` — a bare test page
  (`c=echo` repeats what you say, without the agent).
- `GET /health`

## The widget

```js
const { mountVoice } = await import('http://localhost:4200/widget.js');
mountVoice(document.getElementById('voice-slot'), { conversationId });
```

A "Join call" / "Leave" button, a microphone level, what the agent is doing and
the last line it heard.

## Testing without a microphone

`npx tsx src/probe.ts <conversationId> "phrase" "wait:10" "phrase" …` joins the
room as the person, speaks each phrase (synthesized), records the agent's
voice to `logs/probe-agent.wav` and prints its transcript.
`npx tsx src/judgeTable.ts` runs the judge over 15 test answers.
