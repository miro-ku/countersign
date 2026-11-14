const U='http://localhost:5173';
const txt=async()=>await page.evaluate(()=>document.body.innerText);
const waitFor=async(pred,ms=90000)=>{const t=Date.now();while(Date.now()-t<ms){const b=await txt();if(pred(b))return +((Date.now()-t)/1000).toFixed(1);await sleep(250);}return -1;};
const shot=async(n)=>{await fs.mkdir('./artifacts',{recursive:true});await page.screenshot({path:'./artifacts/'+n+'.png'});console.log('SHOT',pwd+'/artifacts/'+n+'.png');};
await openTab(U+'/?agent=6af8a00f3ea029babf1a5652&conversation=6af8a00f3ea029babf1a5653');
const t0=Date.now();
await page.getByRole('button',{name:/(Connect|Finish) Slack/}).click();
for(let i=0;i<80;i++){ if(page.url().includes('slack.com')) break; await sleep(250);} 
await sleep(4000);
console.log('secs',(Date.now()-t0)/1000,page.url().slice(0,120));
await shot('r1-row2-c');
console.log((await snapshot(page,{interactive:true})).tree);
