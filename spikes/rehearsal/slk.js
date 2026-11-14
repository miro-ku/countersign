const ws=await slack.listWorkspaces(); const w=ws.find(x=>/MongoHack/i.test(x.name)); console.log(w&&{teamId:w.teamId,name:w.name});
const sc=await slack.getClient(w.teamId);
const {messages}=await sc.conversations.history({channel:'C0CHQPNT13Q',limit:8});
console.log(messages.map(m=>({ts:m.ts,user:m.user,text:m.text})));
