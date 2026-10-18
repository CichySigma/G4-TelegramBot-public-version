const pending = new WeakMap();

function verificationError() {
  const error = new Error('Automatyczne odnowienie weryfikacji G4Skins nie powiodło się w wyznaczonym czasie. Użyj /verify, aby wykonać weryfikację ręcznie, a następnie /check.');
  error.code = 'SITE_VERIFICATION';
  return error;
}

function isCloudflareFrame(frame) {
  try {
    const url = new URL(frame.url());
    return url.protocol === 'https:' && url.hostname === 'challenges.cloudflare.com';
  } catch { return false; }
}

async function hasChallenge(page) {
  const title = await page.title();
  return /just a moment|attention required|checking your browser|access denied/i.test(title) ||
    page.frames().some(isCloudflareFrame);
}

async function ready(page, predicate, timeout) {
  const handle = await page.waitForFunction(predicate, {timeout, polling:250});
  try { return await handle.jsonValue(); }
  finally { await handle.dispose(); }
}

async function clickVerification(page) {
  // Limit clicks to visible checkboxes inside the actual Cloudflare origin.
  // Never click generic buttons on the application or verification error links.
  for (const frame of page.frames().filter(isCloudflareFrame)) {
    let checkbox;
    try {
      checkbox = await frame.$('input[type="checkbox"], [role="checkbox"]');
      if (checkbox && await checkbox.boundingBox()) {
        await checkbox.click({delay:80});
        return true;
      }
      if (await clickClosedCheckbox(page,frame)) return true;
    } catch (error) {
      if (page.isClosed()) throw error;
    } finally { if (checkbox) await checkbox.dispose(); }
  }
  return false;
}

async function clickClosedCheckbox(page,frame) {
  // Cloudflare renders its checkbox in a closed shadow root. The pinned CDP
  // driver exposes the frame client; pierce only this verified-origin document.
  if(!isCloudflareFrame(frame) || !frame.client?.send) return false;
  const {root}=await frame.client.send('DOM.getDocument',{depth:-1,pierce:true});
  const queue=[root];
  while(queue.length) {
    const node=queue.shift();
    const attributes=node.attributes || [];
    const attrs=Object.fromEntries(Array.from({length:attributes.length/2},(_,index)=>[attributes[index*2],attributes[index*2+1]]));
    if((node.nodeName==='INPUT' && attrs.type==='checkbox') || attrs.role==='checkbox') {
      let element;
      try {
        const {model}=await frame.client.send('DOM.getBoxModel',{backendNodeId:node.backendNodeId});
        element=await frame.frameElement();
        const outer=await element.boundingBox();
        if(!outer) continue;
        const x=(model.content[0]+model.content[2])/2;
        const y=(model.content[1]+model.content[5])/2;
        if(model.width<=0 || model.height<=0 || x<0 || y<0 || x>outer.width || y>outer.height) continue;
        await page.mouse.click(outer.x+x,outer.y+y,{delay:80});
        return true;
      } catch(error) { if(page.isClosed()) throw error; }
      finally {if(element) await element.dispose();}
    }
    queue.push(...(node.children||[]),...(node.shadowRoots||[]));
    if(node.contentDocument) queue.push(node.contentDocument);
  }
  return false;
}

function recoveryTimeout() {
  const value = Number(process.env.CF_RECOVERY_TIMEOUT_MS || 90000);
  return Number.isFinite(value) ? Math.min(180000, Math.max(1000,value)) : 90000;
}

async function recover(page, predicate, timeout) {
  console.info(`[Cloudflare] Lokalne odnowienie weryfikacji; limit ${timeout} ms.`);
  const deadline = Date.now()+timeout;
  let clicks = 0;
  let lastClick = 0;
  // Restart one stalled challenge while preserving this browser and its cookies.
  try { await page.reload({waitUntil:'domcontentloaded',timeout:Math.min(timeout,15000)}); }
  catch (error) { if (page.isClosed()) throw error; }
  while (Date.now()<deadline && !page.isClosed()) {
    try {
      const result=await ready(page,predicate,Math.max(1,Math.min(1000,deadline-Date.now())));
      console.info('[Cloudflare] Dostęp do strony został potwierdzony.');
      return result;
    }
    catch (error) { if (error.name!=='TimeoutError' && !/context was destroyed|frame was detached/i.test(error.message)) throw error; }
    if (clicks<3 && Date.now()-lastClick>=5000 && await clickVerification(page)) {
      clicks++;
      lastClick=Date.now();
      console.info(`[Cloudflare] Próba weryfikacji ${clicks}/3.`);
    }
  }
  console.warn('[Cloudflare] Nie potwierdzono dostępu; wymagana ręczna weryfikacja.');
  throw verificationError();
}

async function waitForPageAccess(page,predicate,{timeout=30000,challengeTimeout=recoveryTimeout()}={}) {
  const start=Date.now();
  try { return await ready(page,predicate,Math.min(timeout,2000)); }
  catch (error) { if(error.name!=='TimeoutError') throw error; }
  if (!(await hasChallenge(page))) {
    return ready(page,predicate,Math.max(1,timeout-(Date.now()-start)));
  }
  if(process.env.CF_AUTO_RECOVERY==='false') throw verificationError();
  if(pending.has(page)) {
    await pending.get(page);
    return ready(page,predicate,timeout);
  }
  const promise=recover(page,predicate,challengeTimeout);
  pending.set(page,promise);
  try {return await promise;}
  finally {pending.delete(page);}
}

module.exports={waitForPageAccess,isCloudflareFrame,clickVerification};
