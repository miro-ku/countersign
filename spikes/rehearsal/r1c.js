const U='http://localhost:5173';
const txt=async()=>await page.evaluate(()=>document.body.innerText);
const waitFor=async(pred,ms=90000)=>{const t=Date.now();while(Date.now()-t<ms){const b=await txt();if(pred(b))return +((Date.now()-t)/1000).toFixed(1);await sleep(250);}return -1;};
const shot=async(n)=>{await fs.mkdir('./artifacts',{recursive:true});await page.screenshot({path:'./artifacts/'+n+'.png'});console.log('SHOT',pwd+'/artifacts/'+n+'.png');};
await openTab(U+'/?agent=6af8a00f3ea029babf1a5652&conversation=6af8a00f3ea029babf1a5653');
console.log('header before:', (await snapshot(page,{selector:'header'})).tree);
const t0=Date.now();
await page.getByRole('button',{name:/(Connect|Finish) Slack/}).click();
let ok=false; for(let i=0;i<80;i++){ if(page.url().includes('slack.com/oauth')){ok=true;break;} await sleep(250);} 
console.log('to slack secs',(Date.now()-t0)/1000, ok);
await page.getByRole('button',{name:'Allow'}).waitFor({timeout:20000});
const ws=await page.getByRole('combobox').first().textContent().catch(()=>'?'); console.log('workspace shown:',ws);
const t1=Date.now();
await page.getByRole('button',{name:'Allow'}).click();
const seen=[]; for(let i=0;i<240;i++){ const u=page.url(); if(seen[seen.length-1]!==u){seen.push(u); console.log(((Date.now()-t0)/1000).toFixed(1),'URL',u.slice(0,160));} if(u.startsWith(U)) break; await sleep(250);} 
const w=await waitFor(b=>/Disconnect|Slack ·|Slack\n/.test(b)||false,15000);
console.log('back on page, total secs',(Date.now()-t0)/1000,'after Allow',(Date.now()-t1)/1000);
await sleep(1500);
await shot('r1-row2-b');
console.log((await snapshot(page,{selector:'header'})).tree);
console.log((await txt()).slice(0,600));
