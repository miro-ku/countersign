#!/bin/bash
# Holds a notes_add call for approval, probes the gateway's MCP resource and
# prompt methods while it is held, then stops (or switches) and checks the held
# call was released at once. Usage: spikes/release.sh stop|switch [base] [provider]
MODE=${1:-stop}; B=${2:-http://localhost:4100/api}; TO=${3:-codex}
J='content-type: application/json'
g() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log($1)})"; }
AID=$(curl -s -XPOST $B/agents -H "$J" -d '{"name":"Gateway check","instructions":"You keep notes for Miro. Use your tools; do exactly what is asked.","defaultProvider":"claude-code"}' | g "r._id")
CID=$(curl -s -XPOST $B/conversations -H "$J" -d "{\"agentId\":\"$AID\"}" | g "r._id"); echo "conversation $CID"
curl -s -XPOST $B/conversations/$CID/messages -H "$J" -d '{"text":"add a note saying epsilon","source":"text"}' >/dev/null
for i in $(seq 1 60); do a=$(curl -s $B/conversations/$CID | g "r.asks.filter(a=>a.status==="open").length"); [ "$a" != 0 ] && break; sleep 1; done; echo "open asks: $a"
URL=$(ps -ax -o command | grep -o "http://127.0.0.1:[0-9]*/mcp/[A-Za-z0-9_-]*" | tail -1)
rpc() { curl -s -XPOST "$URL" -H "$J" -H 'accept: application/json, text/event-stream' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" | grep -o '{.*}' | head -c 260; echo; }
echo "-- initialize (capabilities):"; rpc initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}'
for m in resources/list resources/templates/list prompts/list; do echo "-- $m:"; rpc $m '{}'; done
echo "-- resources/read:"; rpc resources/read '{"uri":"file:///etc/passwd"}'
echo "-- prompts/get:"; rpc prompts/get '{"name":"x"}'
T0=$(date +%s)
if [ "$MODE" = stop ]; then curl -s -XPOST $B/conversations/$CID/stop; else curl -s -XPOST $B/conversations/$CID/provider -H "$J" -d "{\"provider\":\"$TO\"}" | head -c 0; fi; echo
sleep 3
curl -s $B/conversations/$CID | g "'asks open now: '+r.asks.filter(a=>a.status==="open").length+'\n'+r.messages.map(m=>m.seq+' '+m.role+' '+(m.provider||'')+' '+m.text.slice(0,120)+' '+JSON.stringify(m.steps.filter(s=>s.toolResponse)).slice(0,200)).join('\n')"
echo "server log:"; grep "held call released" /tmp/mongohack-server.log | tail -2
