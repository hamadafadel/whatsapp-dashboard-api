'use strict';
// I/O boundary only. Real SendQueue, dispatch and authorization still execute.
const {randomUUID}=require('crypto'),{fault}=require('../send-queue');
class FixtureQueueStore{
 constructor(){this.rows=[];this.generations=new Map();}
 async ready(){}
 async sessions(){return [];}// Deterministically drained by the test, never a timer.
 async generation(s){return this.generations.get(s)||0;}
 async enqueue({sessionId,owner,requestId,items,generation}){
  if(!requestId)throw fault('IDEMPOTENCY_KEY_REQUIRED',400);
  if(generation!==await this.generation(sessionId))throw fault('QUEUE_GENERATION_CHANGED',409);
  const old=this.rows.find(r=>r.request_id===requestId&&r.owner_name===owner);if(old)return {jobId:old.id};
  const rows=items.map(i=>({id:randomUUID(),session_id:sessionId,owner_name:owner,request_id:requestId,kind:i.kind,payload:i.payload,state:'pending'}));this.rows.push(...rows);return {jobId:rows[0].id};
 }
 async lock(sid){return {claim:async()=>{const r=this.rows.find(x=>x.session_id===sid&&x.state==='pending');if(!r)return null;r.state='sending';return r;},finish:async(r,state,result,reason)=>Object.assign(r,{state,result,reason}),release:async()=>{}};}
 async snapshot(sid){return this.rows.filter(r=>r.session_id===sid);}
 async cancel(sid){let cancelled=0;for(const r of this.rows)if(r.session_id===sid&&r.state==='pending'){r.state='cancelled';cancelled++;}const generation=await this.generation(sid)+1;this.generations.set(sid,generation);return {cancelled,generation};}
}
module.exports={FixtureQueueStore};
