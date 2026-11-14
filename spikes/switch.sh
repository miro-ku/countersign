#!/bin/bash
# Switch checks against a server started with TEST_PROVIDER=claude-test.
# Usage: spikes/switch.sh [base-url] [other-provider]
B=${1:-http://localhost:4101/api}; OTHER=${2:-claude-test}
J='content-type: application/json'
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }
wait_ask() { for i in $(seq 1 60); do id=$(curl -s $B/conversations/$CID | field ".asks.filter(a=>a.status==="open")[0]?._id ?? ''"); [ -n "$id" ] && { echo $id; return; }; sleep 1; done; }
wait_idle() { sleep 2; for i in $(seq 1 120); do g=$(curl -s $B/conversations/$CID | field ".messages.some(m=>m.generating)"); [ "$g" = false ] && return; sleep 1; done; }
say() { curl -s -XPOST $B/conversations/$CID/messages -H "$J" -d "{\"text\":\"$1\",\"source\":\"text\"}" > /dev/null; }
switch() { curl -s -XPOST $B/conversations/$CID/provider -H "$J" -d "{\"provider\":\"$1\"}" > /dev/null; }
answer() { curl -s -XPOST $B/asks/$1/answer -H "$J" -d "{\"answer\":\"$2\",\"scope\":\"$3\",\"source\":\"button\"}" > /dev/null; }
show() {
  curl -s $B/conversations/$CID | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
for(const m of r.messages)console.log(" msg",m.seq,m.role,m.provider||"",m.text.replace(/\n/g," ").slice(0,150));
console.log(" open asks:",r.asks.filter(a=>a.status==="open").length);
for(const e of r.ledger.reverse())console.log(" ledger",e.seq,e.outcome,e.action,JSON.stringify(e.args),e.provider,e.decidedBy||"");})'
  curl -s "$B/conversations/$CID" > /dev/null
}
new_conv() {
  AID=$(curl -s -XPOST $B/agents -H "$J" -d '{"name":"Notebook","instructions":"You keep notes for Miro. Use your tools; do exactly what is asked.","defaultProvider":"claude-code"}' | field ._id)
  CID=$(curl -s -XPOST $B/conversations -H "$J" -d "{\"agentId\":\"$AID\"}" | field ._id)
}

echo "== A. switch while an ask is open, then approve"
new_conv
say "add a note saying alpha"
ASK=$(wait_ask); echo " open ask $ASK; switching to $OTHER"
switch $OTHER; sleep 20
echo " asks now open: $(curl -s $B/conversations/$CID | field '.asks.map(a=>a._id).join(",")')"
ASK2=$(wait_ask); answer $ASK2 approve once
wait_idle; show

[ "$ONLY_A" = 1 ] && exit 0
echo "== B. declined on claude-code stays declined on $OTHER"
new_conv
say "add a note saying beta"; ASK=$(wait_ask); answer $ASK decline conversation; wait_idle
switch claude-code >/dev/null; switch $OTHER
say "Add the note saying beta, please, exactly that text."
wait_idle
echo "== C. approved for the conversation on claude-code is allowed on $OTHER"
switch claude-code
say "add a note saying gamma"; ASK=$(wait_ask); answer $ASK approve conversation; wait_idle
switch $OTHER
say "Add another note saying gamma, exactly that text."
wait_idle; show
