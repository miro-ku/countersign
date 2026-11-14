const U='http://localhost:5173';
const txt=async()=>await page.evaluate(()=>document.body.innerText);
const waitFor=async(pred,ms=90000)=>{const t=Date.now();while(Date.now()-t<ms){const b=await txt();if(pred(b))return +((Date.now()-t)/1000).toFixed(1);await sleep(250);}return -1;};
const shot=async(n)=>{await fs.mkdir('./artifacts',{recursive:true});await page.screenshot({path:'./artifacts/'+n+'.png'});console.log('SHOT',pwd+'/artifacts/'+n+'.png');};
const out=async(n)=>{const b=await page.screenshot();console.log('B64 '+n+' '+Buffer.from(b).toString('base64'));};
await openTab(U);
await page.getByRole('button',{name:'New agent'}).first().click();
await page.locator('#agent-title').fill('Rehearsal 2');
await page.locator('#agent-instructions').fill('You help the team send customer updates in Slack.\nKeep messages short and factual.');
let t0=Date.now();
await page.getByRole('button',{name:'Create agent'}).click();
console.log('create secs',await waitFor(b=>b.includes('Rehearsal 2')&&!b.includes('Create agent'),20000),'url',page.url());
t0=Date.now();
await page.getByRole('button',{name:/(Connect|Finish) Slack/}).click();
for(let i=0;i<80;i++){ if(page.url().includes('slack.com')) break; await sleep(250);} 
let sn, ref;
for(let i=0;i<40;i++){ sn=await snapshot(page,{interactive:true}); const m=sn.tree.match(/button "Allow" \[ref=(\w+)\]/); if(m){ref=m[1];break;} await sleep(500);} 
console.log('Allow visible secs',(Date.now()-t0)/1000, ref, /combobox[^\n]*"MongoHack Demo"/.test(sn.tree)?'workspace MongoHack Demo':'WORKSPACE?', /not approved/.test(sn.tree)?'warning shown':'');
await out('r2-row2-slack');
const t1=Date.now();
await page.locator(ref).click();
for(let i=0;i<240;i++){ if(page.url().startsWith(U)) break; await sleep(250);} 
await waitFor(b=>b.includes('Rehearsal 2'),15000);
const c=await waitFor(b=>/Disconnect Slack/.test(b)||true,1);
await page.getByRole('button',{name:'Disconnect Slack'}).waitFor({timeout:15000}).catch(()=>console.log('no Disconnect chip'));
console.log('back with chip, total secs',(Date.now()-t0)/1000,'after Allow',(Date.now()-t1)/1000, page.url());
await out('r2-row2-back');
