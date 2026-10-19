const test=require('node:test');
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const daily=require('../src/daily-case');

test('Daily Case DOM, history, timing and message regression',async()=>{
  const browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const page=await browser.newPage();
    const row=(weapon,skin,value,image)=>`<div class="daily-reward-history-table"><table><tbody><tr><td><img src="${image}"><div class="item-name-weapon">${weapon}</div><div class="item-name-skin">${skin}</div></td><td>${value}</td><td>2026-01-01 12:00:00</td></tr></tbody></table></div>`;
    await page.setContent(row('Experience points','','700 EXP','/exp.svg'));
    const exp=await page.evaluate(daily.latestHistoryRow);
    assert.equal(exp.type,'exp');assert.equal(exp.amount,'700');
    await page.setContent(row('Sample case','Case','4,00 zł','/cases/sample.webp'));
    const crate=await page.evaluate(daily.latestHistoryRow);
    assert.equal(crate.type,'case');assert.equal(crate.name,'Sample case');assert.equal(crate.value,'4,00 zł');
    assert.notEqual(crate.signature,exp.signature);
    await page.setContent(row('FAMAS','Crypsis (FN)','9,00 zł','/items/sample.png'));
    assert.equal((await page.evaluate(daily.latestHistoryRow)).type,'skin');
    await page.setContent('<div class="top-options" style="display:none"><button class="G_Button big max">Hidden</button></div><div class="top-options"><button class="G_Button block big max" disabled><div class="button_text">18 : 37 : 15</div></button></div>');
    assert.equal((await daily.waitForDailyButton(page,1000)).blocked,true);
    assert.equal((await daily.clickDailyButton(page)).blocked,true);
    await page.setContent('<script>setTimeout(()=>{document.body.innerHTML=`<div class="top-options"><button class="G_Button big max" onclick="window.clicks=(window.clicks||0)+1">Open</button></div>`},3500)</script>');
    await daily.waitForDailyButton(page,6000);
    await daily.clickDailyButton(page);
    assert.equal(await page.evaluate(()=>window.clicks),1);
    await page.setContent('<div id="__nuxt"><div class="top-options"><button class="G_Button big max">Open</button></div></div><script>window.readyAt=Date.now()+900;document.querySelector("#__nuxt").__vue_app__={$nuxt:{isHydrating:false}};setTimeout(()=>{const b=document.querySelector("button");b[Symbol("_vei")]={onClick:()=>{}};b.onclick=()=>window.clicks=1;},900)</script>');
    assert.equal(await page.evaluate(daily.dailyButtonState),null);
    await daily.clickDailyButton(page);
    assert.equal(await page.evaluate(()=>window.clicks),1);
    assert.ok(await page.evaluate(()=>Date.now()>=window.readyAt));
    await page.setContent('<div class="top-options"><button class="G_Button big max" onclick="window.unexpected=true">Open</button></div><div style="position:fixed;inset:0;z-index:999;background:#fff">An unrelated popup</div>');
    await assert.rejects(()=>daily.clickDailyButton(page),/zasłania/);
    assert.equal(await page.evaluate(()=>window.unexpected),undefined);
    await page.setContent('<div class="top-options"><a class="G_Button big max" href="/daily-case">Requirements</a></div>');
    await assert.rejects(()=>daily.clickDailyButton(page),/warunków/);
    await page.setContent('<div class="top-options"><button class="G_Button big max"><div class="button_load"></div>Open</button></div>');
    await assert.rejects(()=>daily.clickDailyButton(page),/przetwarza/);
    await page.setContent('<title>Just a moment...</title>');
    process.env.CF_AUTO_RECOVERY='false';
    try { await assert.rejects(()=>daily.waitForDailyButton(page,100),{code:'SITE_VERIFICATION'}); }
    finally { delete process.env.CF_AUTO_RECOVERY; }
    assert.equal(daily.parseCooldown('18 : 37 : 15'),67035000);
    assert.equal(daily.parseCooldown('20h'),72000000);
    assert.equal(daily.parseCooldown('Wymagany wyższy poziom'),null);
    const message=daily.formatOpened('700 EXP',Date.now()+72000000);
    assert.match(message,/700 EXP/);assert.match(message,/Następny Daily Case/);
    assert.doesNotMatch(daily.formatOpened(null,Date.now()+300000,false),/Następny Daily Case za/);
  }finally{await browser.close();}
});
