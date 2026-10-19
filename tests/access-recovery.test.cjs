const test=require('node:test');
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const {waitForPageAccess}=require('../src/access-recovery');
const predicate=()=>document.querySelector('#ready') ? {found:true} : null;

test('Local renewal handles passive and checkbox challenges with a bounded fallback',async()=>{
  const browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const page=await browser.newPage();
    let mode='normal';
    let reloads=0;
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.hostname==='recovery.test' && url.pathname==='/') {
        reloads++;
        let content='<title>Ready</title><div id="ready"></div>';
        if(mode==='passive') content='<title>Just a moment...</title><script>setTimeout(()=>{document.title="Ready";document.body.innerHTML="<div id=ready></div>"},2000)</script>';
        if(mode==='checkbox' || mode==='closed' || mode==='decoy') {
          const origin=mode==='decoy'?'challenges.cloudflare.com.evil.test':'challenges.cloudflare.com';
          content=`<title>Just a moment...</title><iframe src="https://${origin}/${mode==='closed'?'closed':'test'}"></iframe><script>onmessage=()=>{document.title='Ready';document.body.innerHTML='<div id=ready></div>'}</script>`;
        }
        if(mode==='stalled') content='<title>Just a moment...</title>Verification';
        return request.respond({status:200,contentType:'text/html',body:content});
      }
      if(url.pathname==='/test') return request.respond({status:200,contentType:'text/html',body:'<input type="checkbox" onclick="parent.postMessage(\'verified\',\'*\')">'});
      if(url.pathname==='/closed') return request.respond({status:200,contentType:'text/html',body:'<div id="host"></div><script>const root=document.querySelector("#host").attachShadow({mode:"closed"});root.innerHTML="<input type=checkbox>";root.querySelector("input").onclick=()=>parent.postMessage("verified","*")</script>'});
      return request.abort();
    });
    page.on('console',()=>{});
    await page.goto('https://recovery.test');
    assert.equal((await waitForPageAccess(page,predicate,{timeout:5000})).found,true);
    assert.equal(reloads,1);
    mode='passive';await page.goto('https://recovery.test');
    assert.equal((await waitForPageAccess(page,predicate,{timeout:1000,challengeTimeout:4000})).found,true);
    mode='checkbox';await page.goto('https://recovery.test');
    assert.equal((await waitForPageAccess(page,predicate,{timeout:1000,challengeTimeout:4000})).found,true);
    mode='closed';await page.goto('https://recovery.test');
    assert.equal((await waitForPageAccess(page,predicate,{timeout:1000,challengeTimeout:4000})).found,true);
    mode='decoy';await page.goto('https://recovery.test');
    const start=Date.now();
    await assert.rejects(()=>waitForPageAccess(page,predicate,{timeout:1000,challengeTimeout:500}),{code:'SITE_VERIFICATION'});
    assert.ok(Date.now()-start<5000);
    mode='stalled';await page.goto('https://recovery.test');
    await assert.rejects(()=>waitForPageAccess(page,predicate,{timeout:1000,challengeTimeout:500}),{code:'SITE_VERIFICATION'});
    assert.equal(await page.title(),'Just a moment...');
  }finally{await browser.close();}
});
