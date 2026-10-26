'use strict';
const {randomUUID,createHash}=require('node:crypto');
const fault=(code,status=503)=>Object.assign(new Error(code),{code,status,definitive:true});
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
class PgSendQueueStore {
 constructor(pool){this.pool=pool;}
 async ready(){await this.pool.query('SELECT id,batch_id,sequence,session_id,owner_name,request_id,fingerprint,item_index,kind,payload,state,attempt_token,resolution_at,result,reason,created_at,updated_at FROM public.dashboard_send_queue LIMIT 0');await this.pool.query('SELECT session_id,generation FROM public.dashboard_send_queue_sessions LIMIT 0');}
 async generation(sessionId){return Number((await this.pool.query('SELECT generation FROM public.dashboard_send_queue_sessions WHERE session_id=$1',[sessionId])).rows[0]?.generation||0);}
 async enqueue({sessionId,owner,requestId,items,identity,generation=0}){
  if(!/^[A-Za-z0-9_-]{16,100}$/.test(requestId||''))throw fault('IDEMPOTENCY_KEY_REQUIRED',400);
  if(!owner||!sessionId||!Array.isArray(items)||!items.length||items.length>100)throw fault('INVALID_QUEUE_REQUEST',400);
  const digest=fingerprint(identity||{sessionId,items});
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('send-request:'||$1||':'||$2,0))",[owner,requestId]);
   const previous=(await c.query('SELECT * FROM public.dashboard_send_queue WHERE owner_name=$1 AND request_id=$2 ORDER BY item_index',[owner,requestId])).rows;
   if(previous.length){
    if(previous[0].session_id!==sessionId||previous[0].fingerprint!==digest)throw fault('IDEMPOTENCY_CONFLICT',409);
    await c.query('COMMIT');return {jobId:previous[0].batch_id,total:previous.length,replayed:true};
   }
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('send-session:'||$1,0))",[sessionId]);
   await c.query('INSERT INTO public.dashboard_send_queue_sessions(session_id) VALUES($1) ON CONFLICT DO NOTHING',[sessionId]);
   const epoch=Number((await c.query('SELECT generation FROM public.dashboard_send_queue_sessions WHERE session_id=$1',[sessionId])).rows[0].generation);
   if(!Number.isSafeInteger(generation)||generation!==epoch)throw fault('QUEUE_CANCELLED_OR_STALE_GENERATION',409);
   const batch=randomUUID();
   for(let i=0;i<items.length;i++)await c.query(
    'INSERT INTO public.dashboard_send_queue(id,batch_id,session_id,owner_name,request_id,fingerprint,item_index,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
    [randomUUID(),batch,sessionId,owner,requestId,digest,i,items[i].kind,JSON.stringify(items[i].payload)]);
   await c.query('COMMIT');return {jobId:batch,total:items.length,replayed:false};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async sessions(){return (await this.pool.query("SELECT q.session_id,min(q.sequence) FROM public.dashboard_send_queue q WHERE q.state IN ('pending','sending') AND NOT EXISTS(SELECT 1 FROM public.dashboard_send_queue b WHERE b.session_id=q.session_id AND b.state='unknown' AND b.resolution_at IS NULL) GROUP BY q.session_id ORDER BY min(q.sequence) LIMIT 100")).rows.map(r=>r.session_id);}
 async lock(sessionId){
  const c=await this.pool.connect();let broken=false;
  const markBroken=()=>{broken=true;};c.on('error',markBroken);
  try{
   const acquired=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('send-worker:'||$1,0)) AS acquired",[sessionId])).rows[0].acquired;
   if(!acquired){c.off('error',markBroken);c.release();return null;}
   // With this advisory lock held, no other live worker can own this session.
   // A prior 'sending' may already have reached Meta: NEVER return it to pending.
   await c.query("UPDATE public.dashboard_send_queue SET state='unknown',reason='WORKER_INTERRUPTED',attempt_token=NULL,updated_at=clock_timestamp() WHERE session_id=$1 AND state='sending'",[sessionId]);
   return {
    claim:async()=>{
     if(broken)throw fault('QUEUE_CONNECTION_LOST');
     const blocked=(await c.query("SELECT 1 FROM public.dashboard_send_queue WHERE session_id=$1 AND state='unknown' AND resolution_at IS NULL LIMIT 1",[sessionId])).rows.length;
     if(blocked)return null;
     const token=randomUUID();
     return (await c.query("UPDATE public.dashboard_send_queue SET state='sending',attempt_token=$2,updated_at=clock_timestamp() WHERE id=(SELECT id FROM public.dashboard_send_queue WHERE session_id=$1 AND state='pending' ORDER BY sequence LIMIT 1) AND state='pending' RETURNING *",[sessionId,token])).rows[0]||null;
    },
    finish:async(row,state,result,reason)=>{
     if(broken)throw fault('QUEUE_CONNECTION_LOST');
     const r=await c.query("UPDATE public.dashboard_send_queue SET state=$3,result=$4::jsonb,reason=$5,updated_at=clock_timestamp() WHERE id=$1 AND attempt_token=$2 AND state='sending' RETURNING id",
      [row.id,row.attempt_token,state,JSON.stringify(result||null),reason||null]);
     if(r.rowCount!==1)throw fault('QUEUE_OWNERSHIP_LOST');
    },
    release:async()=>{try{if(!broken)await c.query("SELECT pg_advisory_unlock(hashtextextended('send-worker:'||$1,0))",[sessionId]);}finally{c.off('error',markBroken);c.release(broken);}}
   };
  }catch(e){c.off('error',markBroken);c.release(true);throw e;}
 }
 async snapshot(sessionId){return (await this.pool.query('SELECT id,batch_id,sequence,session_id,owner_name,request_id,kind,state,resolution_at,reason,created_at,updated_at FROM public.dashboard_send_queue WHERE session_id=$1 ORDER BY sequence',[sessionId])).rows;}
 async cancel(sessionId){
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('send-session:'||$1,0))",[sessionId]);
   const generation=Number((await c.query('INSERT INTO public.dashboard_send_queue_sessions(session_id,generation) VALUES($1,1) ON CONFLICT(session_id) DO UPDATE SET generation=dashboard_send_queue_sessions.generation+1 RETURNING generation',[sessionId])).rows[0].generation);
   const cancelled=(await c.query("UPDATE public.dashboard_send_queue SET state='cancelled',reason='USER_CANCELLED',updated_at=clock_timestamp() WHERE session_id=$1 AND state='pending' RETURNING id",[sessionId])).rowCount;
   await c.query('COMMIT');return {cancelled,generation};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async resolve(sessionId,id){return (await this.pool.query("UPDATE public.dashboard_send_queue SET resolution_at=clock_timestamp(),updated_at=clock_timestamp() WHERE session_id=$1 AND id=$2 AND state='unknown' AND resolution_at IS NULL RETURNING id",[sessionId,id])).rowCount;}
}
class SendQueue {
 constructor({store,dispatch,maxWorkers=4,timeoutMs=120000,onError=()=>{}}){
  Object.assign(this,{store,dispatch,maxWorkers,timeoutMs,onError});this.active=new Set();this.timer=null;this.pumping=false;
 }
 async enqueue(request){await this.store.ready();const result=await this.store.enqueue(request);this.pump().catch(this.onError);return {success:true,queued:true,durable:true,...result};}
 start(){if(this.timer)return;this.timer=setInterval(()=>this.pump().catch(this.onError),1000);this.timer.unref?.();this.pump().catch(this.onError);}
 stop(){clearInterval(this.timer);this.timer=null;}
 async pump(){
  if(this.pumping)return;this.pumping=true;
  try{for(const sid of await this.store.sessions()){
   if(this.active.size>=this.maxWorkers)break;
   if(this.active.has(sid))continue;
   this.active.add(sid);this.run(sid).catch(this.onError).finally(()=>this.active.delete(sid));
  }}finally{this.pumping=false;}
 }
 async run(sid){
  const lock=await this.store.lock(sid);if(!lock)return;
  try{for(let i=0;i<100;i++){
   const row=await lock.claim();if(!row)break;
   let timer;
   try{
    const operation=this.dispatch(row);
    const data=await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('SEND_RESULT_UNKNOWN')),this.timeoutMs);})]);
    if(data?.success!==true)throw fault('SEND_RESULT_UNKNOWN');
    // Store only confirmation metadata, never Tokens or complete webhook responses.
    await lock.finish(row,'sent',{messageId:data.message_id||data.data?.message_id||null},null);
   }catch(error){
    // Only explicit pre-dispatch rejection is definitive. HTTP/network errors may follow a real send.
    const state=error.definitive===true&&error.code!=='SEND_RESULT_UNKNOWN'?'failed':'unknown';
    await lock.finish(row,state,null,state==='unknown'?'SEND_RESULT_UNKNOWN':error.code||'SEND_REJECTED');
    if(state==='unknown')break;
   }finally{clearTimeout(timer);}
  }}finally{await lock.release();}
 }
}
module.exports={PgSendQueueStore,SendQueue,fault};
