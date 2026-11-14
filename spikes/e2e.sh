#!/bin/bash
# End-to-end check of one governed action against a running server.
# Usage: spikes/e2e.sh [base-url]   (default http://localhost:4100/api)
B=${1:-http://localhost:4100/api}
J='content-type: application/json'
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }
wait_ask() { # waits for an open ask in the conversation, prints its id
  for i in $(seq 1 60); do
    id=$(curl -s $B/conversations/$CID | field ".asks.filter(a=>a.status==="open")[0]?._id ?? ''")
    [ -n "$id" ] && { echo $id; return; }; sleep 1
  done
}
wait_idle() {
  for i in $(seq 1 90); do
    g=$(curl -s $B/conversations/$CID | field ".messages.some(m=>m.generating)")
    [ "$g" = false ] && return; sleep 1
  done
}
show() {
  curl -s $B/conversations/$CID | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
for(const m of r.messages)console.log(" msg",m.seq,m.role,m.provider||"",m.text.replace(/\n/g," ").slice(0,140));
console.log(" open asks:",r.asks.filter(a=>a.status==="open").length);
for(const e of r.ledger.reverse())console.log(" ledger",e.seq,e.outcome,e.action,JSON.stringify(e.args),e.provider,e.decidedBy||"",JSON.stringify(e.result??"").slice(0,90));})'
}

AID=$(curl -s -XPOST $B/agents -H "$J" -d '{"name":"Notebook","instructions":"You keep notes for Miro. Use your tools; do exactly what is asked.","defaultProvider":"claude-code","testTools":true}' | field ._id)
CID=$(curl -s -XPOST $B/conversations -H "$J" -d "{\"agentId\":\"$AID\"}" | field ._id)
echo "agent $AID conversation $CID"
curl -sN $B/conversations/$CID/events > /tmp/e2e-events-$CID.log & SSE=$!

echo "== 1. add a note saying hello → ask → approve"
curl -s -XPOST $B/conversations/$CID/messages -H "$J" -d '{"text":"add a note saying hello","source":"text"}' > /dev/null
ASK=$(wait_ask); echo " open ask $ASK (event stream: $(grep -c '"type":"ask"' /tmp/e2e-events-$CID.log) ask events)"
curl -s -XPOST $B/asks/$ASK/answer -H "$J" -d '{"answer":"approve","scope":"once","source":"button"}' > /dev/null
wait_idle; show

echo "== 2. add a note saying goodbye → decline for the conversation"
curl -s -XPOST $B/conversations/$CID/messages -H "$J" -d '{"text":"add a note saying goodbye","source":"text"}' > /dev/null
ASK=$(wait_ask); echo " open ask $ASK"
curl -s -XPOST $B/asks/$ASK/answer -H "$J" -d '{"answer":"decline","scope":"conversation","source":"button"}' > /dev/null
wait_idle

echo "== 3. retry: refused without asking"
curl -s -XPOST $B/conversations/$CID/messages -H "$J" -d '{"text":"Please try adding the note saying goodbye once more, exactly the same text.","source":"text"}' > /dev/null
sleep 3; wait_idle; show
kill $SSE
echo "event stream lines: $(grep -c '^data:' /tmp/e2e-events-$CID.log)"
