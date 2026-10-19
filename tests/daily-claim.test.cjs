const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {observeClaim,socketPacket,rewardText}=require('../src/daily-claim');
function fixture(){
 const client=new EventEmitter();client.send=async()=>{};client.detach=async()=>{client.detached=true;};
 const page={createCDPSession:async()=>client};
 const emit=(direction,payloadData,requestId='socket-1')=>client.emit(`Network.webSocketFrame${direction}`,{requestId,response:{payloadData}});
 return {page,client,emit};
}
test('waits for the matching delayed claim ack; unrelated sockets/ids cannot confirm',async()=>{
 const f=fixture(),observer=await observeClaim(f.page,{timeout:9000});let settled=false;observer.result.then(()=>{settled=true;});
 f.emit('Sent','4212["@User/WheelBonus->Claim",null]');
 f.emit('Received','4313[null,{"reward":{"type":3,"value":999}}]');
 f.emit('Received','4312[null,{"reward":{"type":3,"value":999}}]','other-socket');
 await new Promise(r=>setTimeout(r,5500));assert.equal(settled,false);
 f.emit('Received','4312[null,{"reward":{"type":3,"value":700},"private":"excluded"}]');
 const result=await observer.result;assert.equal(result.status,'confirmed');assert.equal(rewardText(result.reward),'700 EXP');assert.equal(result.private,undefined);
 await observer.dispose();assert.equal(f.client.listenerCount('Network.webSocketFrameReceived'),0);assert.equal(f.client.detached,true);
});
test('rejected, absent and malformed acknowledgments never report success',async()=>{
 for(const [ack,status,code] of [['439["not_allowed",null]','rejected','DAILY_CLAIM_REJECTED'],['439[null,{}]','uncertain','DAILY_ACK_WITHOUT_REWARD'],[null,'uncertain','DAILY_ACK_TIMEOUT']]){
  const f=fixture(),observer=await observeClaim(f.page,{timeout:30});f.emit('Sent','429["@User/WheelBonus->Claim",null]');if(ack)f.emit('Received',ack);
  assert.deepEqual(await observer.result,{status,code});await observer.dispose();
 }
 const f=fixture(),observer=await observeClaim(f.page,{timeout:20});assert.equal((await observer.result).code,'DAILY_NO_REQUEST_OBSERVED');await observer.dispose();
 assert.equal(socketPacket('garbage'),null);assert.equal(socketPacket('421[invalid]'),null);
 assert.equal(socketPacket('42/legacy,17["@User/WheelBonus->Claim",null]').namespace,'/legacy,');
 assert.equal(rewardText({type:1,value:23}),null);
});
