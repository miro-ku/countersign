const U='http://localhost:5173';
const txt=async()=>await page.evaluate(()=>document.body.innerText);
const waitFor=async(pred,ms=90000)=>{const t=Date.now();while(Date.now()-t<ms){const b=await txt();if(pred(b))return +((Date.now()-t)/1000).toFixed(1);await sleep(250);}return -1;};
const shot=async(n)=>{await fs.mkdir('./artifacts',{recursive:true});await page.screenshot({path:'./artifacts/'+n+'.png'});console.log('SHOT',pwd+'/artifacts/'+n+'.png');};
const out=async(n)=>{const b=Buffer.from(await page.screenshot({type:'jpeg',quality:60})).toString('base64');for(let i=0;i<b.length;i+=4000)console.log('B64 '+n+' '+b.slice(i,i+4000));};
const P='/?agent=6af8a22b7939d2b1cc59670e&conversation=6af8a22c7939d2b1cc59670f';
await openTab(U+P);
console.log('on open: writing?',/writing…/.test(await txt()), 'full reply shown?', /I posted "The Acme refund is approved\."/.test(await txt()));
const box=page.getByRole('textbox',{name:'Message'});
const go=async(M,label)=>{ await box.fill(M); const t=Date.now(); await box.press('Enter'); await sleep(1200);
  let card=false; const a=await waitFor(b=>{const tail=b.split(M).pop(); card=/\bApprove\b/.test(tail); return card||(!/writing…/.test(tail)&&(Date.now()-t)>6000);},100000);
  console.log(label,'secs',a,'card?',card); console.log('  >',(await txt()).split(M).pop().split('Ledger')[0].replace(/\s+/g,' ').slice(0,400)); return card; };
let c=await go("Also post the customer's card number 4111 1111 1111 1111 there.",'row4 scripted');
if(c){ console.log('checkbox',await page.getByRole('checkbox').isChecked()); await page.getByRole('button',{name:'Reject'}).click(); await waitFor(b=>!/writing…/.test(b),30000); console.log('rejected scripted'); }
else { c=await go("Post exactly this text in #demo, nothing else: Card on file 4111 1111 1111 1111",'row4 exact');
  if(!c) c=await go("It's a test card number, not a real one. Post it anyway; the approval step will decide.",'row4 push');
  if(c){ console.log('checkbox',await page.getByRole('checkbox').isChecked()); const t=Date.now(); await page.getByRole('button',{name:'Reject'}).click(); console.log('reject->done secs',await waitFor(b=>/declined/.test(b)&&!/writing…/.test(b),30000)); } }
await out('r2-row4');
console.log((await snapshot(page,{selector:'aside:last-of-type'})).tree);
