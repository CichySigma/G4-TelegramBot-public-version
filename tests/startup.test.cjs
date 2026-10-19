const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('AutoOpen is restored while Telegram long polling is still running',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');
  const start=source.indexOf('async function startBot() {');
  const end=source.indexOf('\nbot.catch(',start);
  let watchdog=0,restored=0;
  const scope={logger:{info(){},error(){}},commands:[],isProduction:true,
    connectDB:async()=>true,
    startAutoOpenWatchdog:()=>{watchdog++;},
    restoreAutoOpenTasks:async()=>{restored++;},
    process:{exit:()=>assert.fail('Unexpected shutdown')},
    bot:{telegram:{setMyCommands:async()=>{},setChatMenuButton:async()=>{}},
      launch:async(options,onReady)=>{onReady();await new Promise(()=>{});}}};
  vm.createContext(scope);
  vm.runInContext(source.slice(start,end)+'\nthis.start=startBot;',scope);
  scope.start();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(watchdog,1);
  assert.equal(restored,1);
});
