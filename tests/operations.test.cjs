const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {OperationGate}=require('../src/operation-gate');
const source=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');
test('same-user operations cannot overlap; another user and stop remain independent',async()=>{
 const gate=new OperationGate();let release;const blocked=new Promise(r=>{release=r;});
 const a=gate.run('1','autoopen',()=>blocked);assert.equal(gate.busy('1'),'autoopen');
 let navigated=false;const result=await gate.run('1','check',()=>{navigated=true;},busy=>busy);
 assert.equal(result,'autoopen');assert.equal(navigated,false);assert.equal(await gate.run('2','check',async()=>42),42);
 const version=gate.generation('1');gate.cancel('1');assert.equal(gate.current('1',version),false);release();await a;assert.equal(gate.busy('1'),undefined);
 await assert.rejects(()=>gate.run('1','open',async()=>{throw Error('crash');}));assert.equal(gate.busy('1'),undefined);
});
function extract(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
test('durable pending attempts reconcile before inventory or any opening click',async()=>{
 let reconciled=0,clicked=0;
 const scope={operations:new OperationGate(),activeSessions:new Map(),logger:{error(){}},daily:{goToDaily:async()=>({blocked:false})},
   ensureBrowserOpen:async()=>({page:{},browser:{isConnected:()=>true}}),User:{findOne:async()=>({lastDailyAttempt:{status:'pending'}})},
   reconcileAttempt:async()=>{reconciled++;return {success:false,pending:true,error:'pending'};},claim:{observeClaim:async()=>{clicked++;throw Error('Unexpected click');}}};
 vm.createContext(scope);vm.runInContext(extract('async function openDailyCase(ctx) {','// ====== SMART SCHEDULER')+'\nthis.open=openDailyCase;',scope);
 for(let i=0;i<2;i++){const result=await scope.open({from:{id:1},isSilent:true});assert.equal(result.pending,true);}
 assert.equal(reconciled,2);assert.equal(clicked,0);
});
test('stop during a check prevents opening and rescheduling',async()=>{
 const gate=new OperationGate(),sessions=new Map([['1',{autoOpenEnabled:true}]]);let opens=0,schedules=0;
 const scope={operations:gate,maintenance:false,activeSessions:sessions,autoOpenLocks:new Map(),
   checkDailyCase:async()=>{gate.cancel('1');return {found:true,blocked:false};},User:{findOne:async()=>({})},openDailyCase:async()=>{opens++;},
   scheduleUserNext:async()=>{schedules++;},closeBrowserSilently:async()=>{},logger:{error(){}},bot:{telegram:{sendMessage:async()=>{}}}};
 vm.createContext(scope);vm.runInContext(extract('async function runAutoOpenCheck(userId,','/**\n * Rozpoczęcie AutoOpen')+'\nthis.run=runAutoOpenCheck;',scope);
 await scope.run('1',true);assert.equal(opens,0);assert.equal(schedules,0);
});
test('opening persists the guard before one click and awaits ack before history/cooldown',async()=>{
 let release,clicked=0,history=0;const receipt=new Promise(r=>{release=r;});const saved=[];
 const scope={activeSessions:new Map(),operations:new OperationGate(),logger:{warn(){},error(){}},
  ensureBrowserOpen:async()=>({page:{bringToFront:async()=>{},waitForFunction:async()=>({jsonValue:async()=>'19 : 59 : 55',dispose:async()=>{}})},browser:{isConnected:()=>true}}),
  User:{findOne:async()=>({})},readInventory:async()=>[],saveAttempt:async(id,a)=>{saved.push({...a});},
  claim:{observeClaim:async()=>({result:receipt,dispose:async()=>{}}),rewardText:r=>`${r.value} EXP`},
  daily:{goToDaily:async()=>({found:true,blocked:false}),readHistoryInTab:async()=>({signature:++history===1?'old':'new',type:'exp',amount:'700'}),
   clickDailyButton:async(page,before)=>{await before();assert.equal(saved.at(-1).status,'pending');clicked++;return {clicked:true};},parseCooldown:()=>71995000},
  historyReward:r=>`${r.amount} EXP`};
 vm.createContext(scope);vm.runInContext(extract('async function openDailyCase(ctx) {','// ====== SMART SCHEDULER')+'\nthis.open=openDailyCase;',scope);
 const operation=scope.open({from:{id:1},isSilent:true});
 await new Promise(r=>setImmediate(r));assert.equal(clicked,1);assert.equal(history,1);assert.equal(saved.length,1);
 release({status:'confirmed',reward:{type:3,value:700}});
 const result=await operation;assert.equal(result.success,true);assert.equal(result.reward,'700 EXP');assert.equal(history,2);assert.equal(saved.at(-1).status,'confirmed');
});
test('an old scheduler generation cannot persist or install another timer after stop',async()=>{
 const gate=new OperationGate();let writes=0,timers=0;const generation=gate.generation('1');gate.cancel('1');
 const scope={operations:gate,activeSessions:new Map(),setTimeout:()=>{timers++;},persistSchedule:async()=>{writes++;}};
 vm.createContext(scope);vm.runInContext(extract('async function scheduleUserNext(', 'function persistSchedule(')+'\nthis.schedule=scheduleUserNext;',scope);
 assert.equal(await scope.schedule('1',1000,generation),false);assert.equal(writes,0);assert.equal(timers,0);
});
test('stop while /autoopen is still loading cookies cancels that start request',async()=>{
 const gate=new OperationGate();let started=0;
 const scope={operations:gate,loadUser:async()=>({steamUsername:'saved',steamPassword:'saved'}),
  loadSessionCookies:async()=>{gate.cancel('1');return [];},runAutoOpenCheck:async()=>{started++;}};
 vm.createContext(scope);vm.runInContext(extract('async function startAutoOpen(ctx) {','/**\n * Zatrzymanie AutoOpen')+'\nthis.start=startAutoOpen;',scope);
 await scope.start({from:{id:1}});assert.equal(started,0);
});
test('/check cannot announce availability for a login/requirements link or a loading button',async()=>{
 for(const info of [{found:true,blocked:false,actionable:false},{found:true,blocked:false,actionable:true,loading:true}]) {
  const replies=[];const scope={ensureBrowserOpen:async()=>({page:{cookies:async()=>[]},browser:{isConnected:()=>true}}),
   saveSessionCookies:async()=>{},activeSessions:new Map(),daily:{goToDaily:async()=>info},logger:{warn(){}}};
  vm.createContext(scope);vm.runInContext(extract('async function checkDailyCase(ctx) {','async function readInventory(page)')+'\nthis.check=checkDailyCase;',scope);
  const result=await scope.check({from:{id:1},reply:async text=>replies.push(text)});
  assert.equal(result.found,false);assert.ok(result.error);assert.ok(replies.every(text=>!text.includes('Daily Case jest dostępny')));
 }
});
test('Telegram command names are unique and all advertised commands have handlers',()=>{
 const names=[...source.matchAll(/bot\.command\('([^']+)'/g)].map(m=>m[1]);assert.equal(new Set(names).size,names.length);
 const advertised=[...source.matchAll(/command: '\/([^']+)'/g)].map(m=>m[1]);for(const name of advertised)assert.ok(names.includes(name),name);
 for(const command of ['diagnose','lastopen','reconcile','retryopen','preview'])assert.ok(names.includes(command));
 assert.ok(!source.includes('PIN zapisany: ${pin}'));assert.ok(!source.includes("PIN: ${user.familyViewPin || 'BRAK'}"));
});
