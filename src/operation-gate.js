class OperationGate {
  constructor(){this.active=new Map();this.generations=new Map();}
  busy(id){return this.active.get(String(id));}
  async run(id,name,operation,onBusy){
    id=String(id);
    if(this.active.has(id))return onBusy?onBusy(this.active.get(id)):undefined;
    this.active.set(id,name);
    try{return await operation();}finally{this.active.delete(id);}
  }
  generation(id){return this.generations.get(String(id))||0;}
  cancel(id){id=String(id);this.generations.set(id,this.generation(id)+1);}
  current(id,generation){return this.generation(id)===generation;}
}
module.exports={OperationGate};
