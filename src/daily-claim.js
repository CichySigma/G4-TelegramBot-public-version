const CLAIM='@User/WheelBonus->Claim';

// Observe the site's own Socket.IO transaction. Never emit a claim ourselves.
// Keep only the matching acknowledgment, not authentication or other frames.
function socketPacket(payload) {
  if (typeof payload!=='string') return null;
  const match=payload.match(/^4([23])((?:\/[^,]*,)?)?(\d+)(\[.*)$/s);
  if (!match) return null;
  try { return {kind:match[1],namespace:match[2]||'',id:match[3],data:JSON.parse(match[4])}; }
  catch { return null; }
}

function sanitizeReward(reward) {
  if (!reward || ![0,1,2,3,4].includes(reward.type)) return null;
  return {type:reward.type,name:typeof reward.name==='string'?reward.name.slice(0,250):null,
    value:Number.isFinite(reward.value)?reward.value:null,id:typeof reward.id==='number'?reward.id:null};
}

async function observeClaim(page, {timeout=25000}={}) {
  const client=await page.createCDPSession();
  let expected=null, timer, resolve, finished=false;
  const result=new Promise(done=>{resolve=done;});
  const finish=value=>{if (!finished) {finished=true;clearTimeout(timer);resolve(value);}};
  const sent=event=>{
    const packet=socketPacket(event.response.payloadData);
    if (!expected && packet?.kind==='2' && packet.data[0]===CLAIM) {
      expected={requestId:event.requestId,id:packet.id,namespace:packet.namespace};
    }
  };
  const received=event=>{
    const packet=socketPacket(event.response.payloadData);
    if (!expected || event.requestId!==expected.requestId || packet?.kind!=='3' ||
        packet.id!==expected.id || packet.namespace!==expected.namespace) return;
    if (packet.data[0]) return finish({status:'rejected',code:'DAILY_CLAIM_REJECTED'});
    const reward=sanitizeReward(packet.data[1]?.reward);
    finish(reward?{status:'confirmed',reward}:{status:'uncertain',code:'DAILY_ACK_WITHOUT_REWARD'});
  };
  client.on('Network.webSocketFrameSent',sent);
  client.on('Network.webSocketFrameReceived',received);
  try {await client.send('Network.enable');}
  catch(error){await client.detach().catch(()=>{});throw error;}
  timer=setTimeout(()=>finish({status:'uncertain',code:expected?'DAILY_ACK_TIMEOUT':'DAILY_NO_REQUEST_OBSERVED'}),timeout);
  return {result, async dispose(){
    finish({status:'cancelled'});
    client.off('Network.webSocketFrameSent',sent);client.off('Network.webSocketFrameReceived',received);
    await client.detach().catch(()=>{});
  }};
}

function rewardText(reward) {
  if (!reward) return null;
  if (reward.type===3 && reward.value!==null) return `${reward.value} EXP`;
  if (reward.type===2 && reward.name) return `${reward.name}${reward.value!==null?` (${(reward.value*4).toFixed(2)} zł)`:''}`;
  // Case names/prices come from the visible history, not a numeric case id.
  return null;
}

module.exports={socketPacket,sanitizeReward,observeClaim,rewardText};
