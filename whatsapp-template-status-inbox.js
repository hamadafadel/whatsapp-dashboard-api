'use strict';
// Receipt recovery NEVER invokes a send route or retries a WhatsApp request.
const {fault}=require('./send-queue');
function event(b,phoneId){
 if(b.phoneNumberId!==phoneId||!phoneId||typeof b.messageId!=='string'||!b.messageId||b.messageId.length>300||!/^[1-9]\d{6,14}$/.test(b.phone||'')||!['sent','delivered','read','failed'].includes(b.status)||!/^\d{10}$/.test(String(b.timestamp)))throw fault('INVALID_STATUS_RECEIPT',422);
 return [b.messageId,b.phone,b.status,Number(b.timestamp),Number.isInteger(b.errorCode)&&b.errorCode>=0&&b.errorCode<=2147483647?b.errorCode:null];
}
class StatusInbox{
 constructor({pool,env=process.env,fetchImpl=fetch}){Object.assign(this,{pool,env,fetchImpl});this.timer=null;this.busy=false;}
 async put(b){const values=event(b,this.env.WHATSAPP_PHONE_NUMBER_ID);await this.pool.query(`INSERT INTO public.whatsapp_template_status_inbox(message_id,phone,status,event_at,error_code) VALUES($1,$2,$3,to_timestamp($4),$5) ON CONFLICT DO NOTHING`,values);return {accepted:true};}
 async drain(){
  const c=await this.pool.connect();try{await c.query('BEGIN');
   const r=await c.query(`WITH pending AS (SELECT * FROM public.whatsapp_template_status_inbox WHERE processed_at IS NULL ORDER BY received_at LIMIT 100 FOR UPDATE SKIP LOCKED),
    recorded AS (INSERT INTO public.whatsapp_template_delivery_events(message_id,phone,status,event_at,error_code)
      SELECT message_id,phone,status,event_at,error_code FROM pending ON CONFLICT DO NOTHING)
    UPDATE public.whatsapp_template_status_inbox i SET processed_at=now() FROM pending p
      WHERE (i.message_id,i.phone,i.status,i.event_at)=(p.message_id,p.phone,p.status,p.event_at) RETURNING i.message_id`);
   await c.query('COMMIT');return r.rowCount;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async recover(){
  const {N8N_STATUS_RECOVERY_URL:origin,N8N_STATUS_RECOVERY_TOKEN:token,N8N_STATUS_CHILD_ID:id}=this.env;
  if(!origin||!token||!id)return {configured:false};
  const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^[-A-Za-z0-9]{10,64}$/.test(id))throw fault('UNSAFE_STATUS_RECOVERY_CONFIG');
  const c=await this.pool.connect();let locked=false,accepted=0;
  const get=async path=>{const r=await this.fetchImpl(new URL(path,url.origin),{method:'GET',headers:{'X-N8N-API-KEY':token},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw fault('STATUS_RECOVERY_UNAVAILABLE');return r.json();};
  try{
   locked=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('wa-status-recovery-v1',0)) AS ok")).rows[0].ok;if(!locked)return {standby:true};
   let cursor='';do{
    const q=new URLSearchParams({workflowId:id,status:'error',limit:'100',includeData:'false'});if(cursor)q.set('cursor',cursor);
    const page=await get('/api/v1/executions?'+q);
    for(const e of page.data||[]){
     if(String(e.workflowId)!==id||!/^[0-9]+$/.test(String(e.id)))continue;
     const execution=await get('/api/v1/executions/'+e.id+'?includeData=true');
     if(String(execution.workflowId)!==id||execution.status!=='error')continue;
     const runs=execution.data?.resultData?.runData?.['Normalize Status Metadata Only']||[];
     for(const run of runs)for(const item of run.data?.main?.[0]||[]){await this.put(item.json);accepted++;}
    }cursor=page.nextCursor||'';
   }while(cursor);
   return {configured:true,recoveredMetadata:accepted};
  }finally{if(locked)await c.query("SELECT pg_advisory_unlock(hashtextextended('wa-status-recovery-v1',0))");c.release();}
 }
 async tick(){if(this.busy||this.env.WHATSAPP_CAMPAIGN_STATUS_WORKER_ENABLED!=='true')return;this.busy=true;try{await this.drain();if(Date.now()-(this.lastRecovery||0)>60000){await this.recover();this.lastRecovery=Date.now();}}finally{this.busy=false;}}
 configured(){return Boolean(this.env.WHATSAPP_PHONE_NUMBER_ID);}
 start(){if(this.timer||this.env.WHATSAPP_CAMPAIGN_STATUS_WORKER_ENABLED!=='true')return;
  if(!this.configured()){console.error('Campaign status worker disabled: recovery configuration is incomplete');return;}
  this.timer=setInterval(()=>this.tick().catch(()=>console.error('Campaign receipt processing unavailable; durable intake retained')),2000);this.timer.unref?.();}
 stop(){clearInterval(this.timer);this.timer=null;}
}
module.exports={StatusInbox,event};
