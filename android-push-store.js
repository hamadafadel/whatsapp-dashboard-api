'use strict';
const crypto=require('crypto');
const {fault,sameHash}=require('./android-push');
class PgAndroidPushStore {
 constructor(pool){this.pool=pool;}
 async transaction(work){const c=await this.pool.connect();try{await c.query('BEGIN');const value=await work(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK').catch(()=>{});if(e.code==='23505')throw fault('DEVICE_CONFLICT',409);throw e;}finally{c.release();}}
 async register(p){return this.transaction(async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('android-push-device:'||$1,0))",[p.installationId]);
  const previous=(await c.query('SELECT * FROM public.android_push_devices WHERE installation_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[p.installationId])).rows[0];
  if(previous&&!sameHash(previous.secret_hash,p.proof))throw fault('DEVICE_CONFLICT',409);
  if(previous&&previous.last_request_id===p.requestId){
   if(previous.request_digest!==p.requestDigest||previous.revoked_at)throw fault('DEVICE_REVISION_CONFLICT',409);return previous;
  }
  if(Number(previous?.revision||0)!==p.revision)throw fault('DEVICE_REVISION_CONFLICT',409);
  const revision=p.revision+1;
  if(previous&&!previous.revoked_at&&previous.owner_name===p.owner){
   return (await c.query(`UPDATE public.android_push_devices SET token_cipher=$2,token_hash=$3,notifications_enabled=$4,
    expires_at=$5,revision=$6,last_request_id=$7,request_digest=$8,updated_at=clock_timestamp()
    WHERE binding_id=$1 RETURNING *`,[previous.binding_id,p.encrypt(previous.binding_id),p.tokenHash,p.enabled,p.expiresAt,revision,p.requestId,p.requestDigest])).rows[0];
  }
  if(previous&&!previous.revoked_at){await c.query('UPDATE public.android_push_devices SET revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE binding_id=$1',[previous.binding_id]);await c.query("UPDATE public.android_notification_deliveries SET status='skipped',error_code='DEVICE_REBOUND',lease_id=NULL,lease_until=NULL WHERE binding_id=$1 AND status IN ('pending','sending')",[previous.binding_id]);}
  return (await c.query(`INSERT INTO public.android_push_devices(binding_id,installation_id,owner_name,secret_hash,token_cipher,token_hash,
    notifications_enabled,expires_at,revision,last_request_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
   [p.bindingId,p.installationId,p.owner,p.proof,p.encrypt(p.bindingId),p.tokenHash,p.enabled,p.expiresAt,revision,p.requestId,p.requestDigest])).rows[0];
 });}
 async getDevice(id){return (await this.pool.query('SELECT * FROM public.android_push_devices WHERE binding_id=$1',[id])).rows[0]||null;}
 async installation(id){return (await this.pool.query('SELECT * FROM public.android_push_devices WHERE installation_id=$1 ORDER BY revision DESC LIMIT 1',[id])).rows[0]||null;}
 async cancelRegistration(p){return this.transaction(async c=>{
  // Same lock/CAS domain as registration. A revoked revision fences an uncertain request
  // even if Logout reaches the server BEFORE the original PUT. Never revive an old login.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('android-push-device:'||$1,0))",[p.installationId]);
  const previous=(await c.query('SELECT * FROM public.android_push_devices WHERE installation_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[p.installationId])).rows[0];
  if(previous&&!sameHash(previous.secret_hash,p.proof))throw fault('DEVICE_CONFLICT',409);
  if(previous){
   if(previous.last_request_id!==p.requestId&&Number(previous.revision)>p.revision)return;
   if(previous.revoked_at&&previous.last_request_id===p.requestId)return;
   await c.query('UPDATE public.android_push_devices SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revision=GREATEST(revision,$2::bigint)+1,updated_at=clock_timestamp() WHERE binding_id=$1',[previous.binding_id,p.revision]);
   await c.query("UPDATE public.android_notification_deliveries SET status='skipped',error_code='DEVICE_REVOKED',lease_id=NULL,lease_until=NULL WHERE binding_id=$1 AND status IN ('pending','sending')",[previous.binding_id]);
  }else{
   await c.query(`INSERT INTO public.android_push_devices(binding_id,installation_id,owner_name,secret_hash,token_cipher,token_hash,
    notifications_enabled,expires_at,revision,last_request_id,request_digest,revoked_at) VALUES($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,clock_timestamp())`,
    [p.bindingId,p.installationId,p.owner,p.proof,p.encrypt(p.bindingId),p.tokenHash,p.expiresAt,p.revision+1,p.requestId,p.requestDigest]);
  }
 });}
 async revoke(id){return this.transaction(async c=>{
  await c.query('UPDATE public.android_push_devices SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revision=revision+1,updated_at=clock_timestamp() WHERE binding_id=$1 AND revoked_at IS NULL',[id]);
  await c.query("UPDATE public.android_notification_deliveries SET status='skipped',error_code='DEVICE_REVOKED',lease_id=NULL,lease_until=NULL WHERE binding_id=$1 AND status IN ('pending','sending')",[id]);
 });}
 async preview(eventId,bindingId){return (await this.pool.query(`SELECT e.*,m.message FROM public.android_notification_events e
  JOIN public.android_notification_deliveries d ON d.event_id=e.event_id AND d.binding_id=$2
  JOIN public.chat_memory m ON m.id=e.message_row_id AND m.session_id=e.session_id
  WHERE e.event_id=$1`,[eventId,bindingId])).rows[0]||null;}
 async acceptedEvents(bindingId,before){return (await this.pool.query(`SELECT e.event_id,e.session_id,e.expires_at FROM public.android_notification_events e
  JOIN public.android_notification_deliveries d ON d.event_id=e.event_id AND d.binding_id=$1
  WHERE d.status='accepted' AND e.expires_at>clock_timestamp() AND ($2::uuid IS NULL OR (e.created_at,e.event_id)<(
   SELECT x.created_at,x.event_id FROM public.android_notification_events x JOIN public.android_notification_deliveries dx ON dx.event_id=x.event_id AND dx.binding_id=$1 WHERE x.event_id=$2))
  ORDER BY e.created_at DESC,e.event_id DESC LIMIT 101`,[bindingId,before||null])).rows;}
 async expand(){return this.transaction(async c=>{
  const events=(await c.query(`SELECT event_id FROM public.android_notification_events WHERE expanded_at IS NULL AND expires_at>clock_timestamp()
   ORDER BY created_at,event_id FOR UPDATE SKIP LOCKED LIMIT 100`)).rows;
  for(const e of events){
   await c.query(`INSERT INTO public.android_notification_deliveries(event_id,binding_id)
    SELECT e.event_id,d.binding_id FROM public.android_notification_events e CROSS JOIN public.android_push_devices d
    WHERE e.event_id=$1 AND d.revoked_at IS NULL AND d.notifications_enabled AND d.expires_at>clock_timestamp()
    AND d.created_at<=e.created_at ON CONFLICT(event_id,binding_id) DO NOTHING`,[e.event_id]);
   await c.query('UPDATE public.android_notification_events SET expanded_at=clock_timestamp() WHERE event_id=$1',[e.event_id]);
  }
 });}
 async claim(){
  const lease=crypto.randomUUID();
  const row=(await this.pool.query(`WITH candidate AS (
   SELECT d.delivery_id FROM public.android_notification_deliveries d JOIN public.android_notification_events e USING(event_id)
   WHERE e.expires_at>clock_timestamp() AND ((d.status='pending' AND d.next_attempt_at<=clock_timestamp())
    OR (d.status='sending' AND d.lease_until<=clock_timestamp()))
   ORDER BY d.created_at,d.delivery_id FOR UPDATE OF d SKIP LOCKED LIMIT 1)
   UPDATE public.android_notification_deliveries d SET status='sending',attempts=d.attempts+1,lease_id=$1,
    lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
   FROM candidate c WHERE d.delivery_id=c.delivery_id RETURNING d.*`,[lease])).rows[0];
  return row||null;
 }
 async event(id){return (await this.pool.query(`SELECT e.*,m.message FROM public.android_notification_events e
  JOIN public.chat_memory m ON m.id=e.message_row_id AND m.session_id=e.session_id WHERE e.event_id=$1`,[id])).rows[0]||null;}
 async renew(claim){return (await this.pool.query(`UPDATE public.android_notification_deliveries SET lease_until=clock_timestamp()+interval '60 seconds'
  WHERE delivery_id=$1 AND lease_id=$2 AND status='sending' AND lease_until>clock_timestamp() RETURNING delivery_id`,[claim.delivery_id,claim.lease_id])).rowCount===1;}
 async finish(claim,status,{code=null,delayMs=0}={}){
  return (await this.pool.query(`UPDATE public.android_notification_deliveries SET status=$3,error_code=$4,
   next_attempt_at=clock_timestamp()+($5::double precision*interval '1 millisecond'),
   accepted_at=CASE WHEN $3='accepted' THEN clock_timestamp() ELSE accepted_at END,
   lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
   WHERE delivery_id=$1 AND lease_id=$2 AND status='sending' AND lease_until>clock_timestamp() RETURNING delivery_id`,
   [claim.delivery_id,claim.lease_id,status,code,delayMs])).rowCount===1;
 }
 async invalidateToken(bindingId,tokenHash){await this.pool.query(`UPDATE public.android_push_devices SET revoked_at=clock_timestamp(),
  revision=revision+1,updated_at=clock_timestamp() WHERE binding_id=$1 AND token_hash=$2 AND revoked_at IS NULL`,[bindingId,tokenHash]);}
 async expire(){await this.pool.query(`UPDATE public.android_notification_deliveries d SET status='expired',error_code='EVENT_EXPIRED',
  lease_id=NULL,lease_until=NULL WHERE status IN ('pending','sending') AND EXISTS(
   SELECT 1 FROM public.android_notification_events e WHERE e.event_id=d.event_id AND e.expires_at<=clock_timestamp())`);}
}
module.exports={PgAndroidPushStore};
