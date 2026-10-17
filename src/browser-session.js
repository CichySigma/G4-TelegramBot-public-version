const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const net = require('net');
const puppeteer = require('puppeteer-core');
const browsers = new Map();
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

async function allocateDebugPort() {
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

async function launchBrowser(userId, config) {
  if (process.env.BROWSER_NATIVE !== 'true') return puppeteer.launch(config);
  if (!/^\d+$/.test(String(userId))) throw new Error('Nieprawidłowy identyfikator profilu przeglądarki.');
  const existing = browsers.get(String(userId));
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    try {return await puppeteer.connect({browserURL:existing.url,defaultViewport:null});}
    catch {existing.child.kill('SIGTERM');await sleep(1000);}
  }
  const dir=path.join(process.env.BROWSER_PROFILE_ROOT || '/app/browser-profiles',String(userId));
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  // Docker restarts change the hostname; these locks belong to the stopped container.
  for (const name of ['SingletonLock','SingletonSocket','SingletonCookie','DevToolsActivePort']) {
    try {fs.unlinkSync(path.join(dir,name));} catch(error) {if(error.code!=='ENOENT') throw error;}
  }
  let spawnError;
  const port=await allocateDebugPort();
  const url=`http://127.0.0.1:${port}`;
  const child=spawn(config.executablePath || '/usr/bin/chromium',[
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    `--user-data-dir=${dir}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',
    '--no-first-run','--no-default-browser-check','--window-size=1366,768','about:blank'
  ],{stdio:'ignore'});
  child.on('error',error=>{spawnError=error;});
  for(let attempt=0;attempt<100;attempt++) {
    if(spawnError) throw spawnError;
    if(child.exitCode!==null) throw new Error(`Przeglądarka zakończyła pracę (kod ${child.exitCode}).`);
    try {
      const browser=await puppeteer.connect({browserURL:url,defaultViewport:null});
      browsers.set(String(userId),{child,url});
      return browser;
    } catch(error) {if(attempt===99) {child.kill('SIGTERM');throw error;}}
    await sleep(200);
  }
  child.kill('SIGTERM');
  throw new Error('Nie udało się połączyć z przeglądarką.');
}

async function getPage(browser) {
  if(process.env.BROWSER_NATIVE==='true') {
    const pages=await browser.pages();
    const current=pages.find(page=>/^https:\/\/(www\.)?g4skins\.com\//.test(page.url()));
    if(current) return current;
    const blank=pages.find(page=>page.url()==='about:blank');
    if(blank) return blank;
  }
  return browser.newPage();
}

async function restoreCookies(page,cookies) {
  if(!Array.isArray(cookies) || !cookies.length) return;
  const existing=await page.browserContext().cookies();
  // Preserve newer cookies in the persistent browser profile instead of overwriting them.
  const fresh=cookies.map(({partitionKey,...cookie})=>cookie).filter(cookie=>
    !existing.some(current=>current.name===cookie.name && current.domain===cookie.domain && current.path===cookie.path));
  if(fresh.length) await page.setCookie(...fresh);
}

async function closeNative(userId, clearProfile=false) {
  if (!/^\d+$/.test(String(userId))) throw new Error('Nieprawidłowy identyfikator profilu.');
  const record=browsers.get(String(userId));
  if(record && record.child.exitCode===null) {
    record.child.kill('SIGTERM');
    for(let attempt=0;attempt<40 && record.child.exitCode===null;attempt++) await sleep(100);
    if(record.child.exitCode===null) {record.child.kill('SIGKILL');await sleep(200);}
  }
  browsers.delete(String(userId));
  if(clearProfile && process.env.BROWSER_NATIVE==='true') {
    const root=path.resolve(process.env.BROWSER_PROFILE_ROOT || '/app/browser-profiles');
    const dir=path.resolve(root,String(userId));
    if(path.dirname(dir)!==root) throw new Error('Profil poza katalogiem przeglądarki.');
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

async function closeAll(clearProfiles=false) {
  for(const id of [...browsers.keys()]) await closeNative(id,clearProfiles);
  if(clearProfiles && process.env.BROWSER_NATIVE==='true') {
    const root=process.env.BROWSER_PROFILE_ROOT || '/app/browser-profiles';
    if(fs.existsSync(root)) for(const id of fs.readdirSync(root)) if(/^\d+$/.test(id)) await closeNative(id,true);
  }
}

module.exports={launchBrowser,getPage,restoreCookies,closeAll,closeNative};
