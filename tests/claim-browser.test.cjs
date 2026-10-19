const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {WebSocketServer}=require('ws'),puppeteer=require('puppeteer-core');
const daily=require('../src/daily-case'),{observeClaim}=require('../src/daily-claim');
test('real Chromium click sends one claim and CDP awaits its delayed socket acknowledgment',async()=>{
 const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const socketServer=new WebSocketServer({server});let claims=0,timer;
 socketServer.on('connection',socket=>socket.on('message',message=>{
  assert.equal(message.toString(),'427["@User/WheelBonus->Claim",null]');claims++;
  timer=setTimeout(()=>socket.send('437[null,{"reward":{"type":3,"value":700}}]'),6200);
 }));
 let browser;
 try {
  browser=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();await page.setContent(`<div class="top-options"><button class="G_Button big max" onclick="socket.send('427[&quot;@User/WheelBonus->Claim&quot;,null]')">Open</button></div><script>var socket=new WebSocket('ws://127.0.0.1:${server.address().port}');socket.onopen=()=>window.connected=true;</script>`);
  await page.waitForFunction(()=>window.connected);
  const observer=await observeClaim(page,{timeout:12000});
  try {await daily.clickDailyButton(page);const outcome=await observer.result;assert.equal(outcome.status,'confirmed');assert.equal(outcome.reward.value,700);assert.equal(claims,1);}
  finally{await observer.dispose();}
 }finally{clearTimeout(timer);if(browser)await browser.close();socketServer.close();await new Promise(r=>server.close(r));}
});
