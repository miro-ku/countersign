const U='http://localhost:5173';
const txt=async()=>await page.evaluate(()=>document.body.innerText);
const waitFor=async(pred,ms=90000)=>{const t=Date.now();while(Date.now()-t<ms){const b=await txt();if(pred(b))return +((Date.now()-t)/1000).toFixed(1);await sleep(250);}return -1;};
const shot=async(n)=>{await fs.mkdir('./artifacts',{recursive:true});await page.screenshot({path:'./artifacts/'+n+'.png'});console.log('SHOT',pwd+'/artifacts/'+n+'.png');};
const out=async()=>{};
const P='/?agent=6af8a22b7939d2b1cc59670e&conversation=6af8a22c7939d2b1cc59670f';
const undoFirst=async(url,label)=>{ await openTab(url);
  console.log(label,'Join call buttons:',await page.getByRole('button',{name:/join/i}).count(),'voice-slot children:',await page.evaluate(()=>document.getElementById('voice-slot')?.childElementCount));
  const s=await snapshot(page,{selector:'aside:last-of-type'});
  const m=[...s.tree.matchAll(/button "SLACK_SEND_MESSAGE executed[^"]*" \[ref=(\w+)\]\n\s*- button "Undo" \[ref=(\w+)\]/g)];
  console.log(label,'undo rows',m.length);
  for(const x of m){ const t=Date.now(); await page.locator(x[2]).click(); await sleep(300); }
  console.log(label,'undone rows visible after secs', await waitFor(b=>(b.match(/SLACK_SEND_MESSAGE\s*undone/g)||[]).length>=m.length,30000));
};
await undoFirst(U+P,'run2');
await undoFirst(U+'/?agent=6af8a00f3ea029babf1a5652&conversation=6af8a00f3ea029babf1a5653','run1');
