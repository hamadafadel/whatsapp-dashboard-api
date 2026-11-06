'use strict';
const {fault,decryptToken,liveMessage}=require('./android-push');
const INVALID_TOKEN=new Set(['messaging/registration-token-not-registered','messaging/invalid-registration-token']);
const TEMPORARY=new Set(['messaging/server-unavailable','messaging/internal-error','messaging/quota-exceeded','app/network-error','app/network-timeout','PUSH_SEND_TIMEOUT']);
function retryDelay(attempt,random=Math.random,retryAfterMs=0){
 const base=Math.min(3600000,30000*2**Math.max(0,Math.min(10,attempt-1)));
 return Math.min(7200000,Math.max(base+Math.floor(base*0.2*random()),Number.isFinite(retryAfterMs)?retryAfterMs:0));
}
function createFirebaseSender({env=process.env,allowSend=false,sdkFactory}={}){
 let messaging;
 const prepare=()=>{
  if(!allowSend)throw fault('PUSH_SENDING_DISABLED',503);
  if(!/^[a-z][a-z0-9-]{4,62}$/.test(env.FIREBASE_PROJECT_ID||'')||!env.GOOGLE_APPLICATION_CREDENTIALS)throw fault('PUSH_CREDENTIALS_UNAVAILABLE',503);
  if(!messaging){
   // No private key literals, no initialization at import/startup, no real credentials in tests.
   const sdk=sdkFactory?sdkFactory():{...require('firebase-admin/app'),...require('firebase-admin/messaging')};
   const name='mehrab-android-push';
   const app=sdk.getApps().find(a=>a.name===name)||sdk.initializeApp({projectId:env.FIREBASE_PROJECT_ID,credential:sdk.applicationDefault()},name);
   if(app.options?.projectId!==env.FIREBASE_PROJECT_ID)throw fault('PUSH_PROJECT_MISMATCH',503);
   messaging=sdk.getMessaging(app);
  }
 };
 const send=async(token,eventId,ttl)=>{
  prepare();
  // Only an opaque event ID is sent as application data. No notification payload, names, JWT or session ID.
  return messaging.send({token,data:{eventId},android:{priority:'high',ttl:Math.max(0,Math.min(ttl,86400000))}});
 };
 send.prepare=prepare;return send;
}
class AndroidPushWorker {
 constructor({store,service,sender,env=process.env,allowDispatch=false,now=Date.now,random=Math.random,timeoutMs=15000}){
  Object.assign(this,{store,service,sender,env,allowDispatch,now,random,timeoutMs});this.running=false;
 }
 async runOnce(limit=10){
  if(!this.allowDispatch)throw fault('PUSH_SENDING_DISABLED',503);
  if(this.running)return;this.running=true;
  try{
   // Configuration/ADC parsing fails before claiming jobs, not after marking a batch as failed.
   await this.sender.prepare?.();
   await this.store.expire();await this.store.expand();
   for(let i=0;i<Math.min(100,Math.max(0,limit));i++){
    const claim=await this.store.claim();if(!claim)break;
    try{
     const event=await this.store.event(claim.event_id),device=await this.store.getDevice(claim.binding_id);
     if(!event||!liveMessage(event)||!await this.service.canDeliver(device,event)){
      await this.store.finish(claim,'skipped',{code:'NOT_AUTHORIZED_OR_EXPIRED'});continue;
     }
     if(claim.attempts>8){await this.store.finish(claim,'failed',{code:'RETRY_LIMIT'});continue;}
     // An authorization lookup may outlast a lease. An old owner must never start a new send.
     if(this.store.renew&&!await this.store.renew(claim))continue;
     const token=decryptToken(device.token_cipher,device.binding_id,this.env);let timer;
     try{await Promise.race([this.sender(token,event.event_id,new Date(event.expires_at).getTime()-this.now()),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('PUSH_SEND_TIMEOUT',503)),this.timeoutMs);})]);}
     catch(e){if(INVALID_TOKEN.has(e.code))await this.store.invalidateToken(device.binding_id,device.token_hash);throw e;}
     finally{clearTimeout(timer);}
     // 'accepted' means FCM accepted the request, NOT that the phone displayed a notification.
     await this.store.finish(claim,'accepted');
    }catch(e){
     const databaseTemporary=/^(08|40|53|57)/.test(e.code||'')||['ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(e.code);
     if((TEMPORARY.has(e.code)||databaseTemporary)&&claim.attempts<8){await this.store.finish(claim,'pending',{code:databaseTemporary?'AUTHORIZATION_OR_STORAGE_UNAVAILABLE':e.code,delayMs:retryDelay(claim.attempts,this.random,e.code==='messaging/quota-exceeded'?Math.max(60000,e.retryAfterMs||0):e.retryAfterMs)});}
     else await this.store.finish(claim,'failed',{code:INVALID_TOKEN.has(e.code)?'INVALID_FCM_TOKEN':TEMPORARY.has(e.code)?'RETRY_LIMIT':'PUSH_DELIVERY_FAILED'});
    }
   }
  }finally{this.running=false;}
 }
}
module.exports={AndroidPushWorker,createFirebaseSender,retryDelay};
