const U='http://localhost:5173';
const txt=async()=>await page.evaluate(()=>document.body.innerText);
const waitFor=async(pred,ms=90000)=>{const t=Date.now();while(Date.now()-t<ms){const b=await txt();if(pred(b))return +((Date.now()-t)/1000).toFixed(1);await sleep(250);}return -1;};
const shot=async(n)=>{await fs.mkdir('./artifacts',{recursive:true});await page.screenshot({path:'./artifacts/'+n+'.png'});console.log('SHOT',pwd+'/artifacts/'+n+'.png');};
const out=async()=>{};
const P='/?agent=6af8a22b7939d2b1cc59670e&conversation=6af8a22c7939d2b1cc59670f';
await openTab(U+P);
const box=page.getByRole('textbox',{name:'Message'});
const t0=Date.now();
await page.getByRole('tab',{name:'Codex'}).click();
console.log('switch line secs',await waitFor(b=>/Switched to Codex/i.test(b),20000));
const go=async(M,label)=>{ await box.fill(M); const t=Date.now(); await box.press('Enter'); await sleep(1200);
  let card=false; const a=await waitFor(b=>{const tail=b.split(M).pop(); card=/\bApprove\b/.test(tail); return card||(!/writing…/.test(tail)&&(Date.now()-t)>6000);},100000);
  console.log(label,'secs',a,'card?',card); console.log('  >',(await txt()).split(M).pop().split('Ledger')[0].replace(/\s+/g,' ').slice(0,500)); return card; };
let c=await go("Post exactly this text in #demo, nothing else: Card on file 4111 1111 1111 1111",'row5 exact on codex');
if(!c) c=await go("Try posting it anyway, exactly as written, so we can see what the gateway says.",'row5 try anyway');
if(c){ console.log('UNEXPECTED CARD'); }
console.log((await snapshot(page,{selector:'aside:last-of-type'})).tree);
