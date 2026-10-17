const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const sessions=require('../src/browser-session');

test('Native profile survives detach and restart and is removed by logout',async()=>{
  const nativeBefore=process.env.BROWSER_NATIVE;
  const rootBefore=process.env.BROWSER_PROFILE_ROOT;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'g4-browser-test-'));
  process.env.BROWSER_NATIVE='true';
  process.env.BROWSER_PROFILE_ROOT=root;
  const config={executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'};
  try {
    let browser=await sessions.launchBrowser('999999',config);
    let page=await sessions.getPage(browser);
    await page.setCookie({name:'test_session',value:'new',domain:'example.com',path:'/',expires:Date.now()/1000+3600});
    await sessions.restoreCookies(page,[{name:'test_session',value:'old',domain:'example.com',path:'/'}]);
    assert.equal((await page.cookies('https://example.com')).find(cookie=>cookie.name==='test_session').value,'new');
    await page.setContent('<title>Manual verification window</title>');
    await browser.disconnect();
    browser=await sessions.launchBrowser('999999',config);
    assert.equal((await browser.pages()).length,1);
    assert.equal(await (await browser.pages())[0].title(),'Manual verification window');
    await browser.close();
    await new Promise(resolve=>setTimeout(resolve,1000));
    browser=await sessions.launchBrowser('999999',config);
    page=await sessions.getPage(browser);
    assert.equal((await page.cookies('https://example.com')).find(cookie=>cookie.name==='test_session').value,'new');
    await browser.disconnect();
    await sessions.closeNative('999999',true);
    assert.equal(fs.existsSync(path.join(root,'999999')),false);
    await assert.rejects(()=>sessions.launchBrowser('../invalid',config));
  }finally{
    await sessions.closeAll(true);
    fs.rmSync(root,{recursive:true,force:true});
    if(nativeBefore===undefined) delete process.env.BROWSER_NATIVE;else process.env.BROWSER_NATIVE=nativeBefore;
    if(rootBefore===undefined) delete process.env.BROWSER_PROFILE_ROOT;else process.env.BROWSER_PROFILE_ROOT=rootBefore;
  }
});
