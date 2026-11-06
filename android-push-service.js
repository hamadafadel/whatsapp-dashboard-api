'use strict';
// Independent process. Never imports server.js, binds HTTP or runs startup DDL.
const LOCK_SQL="SELECT pg_try_advisory_lock(724106,316001) AS acquired";
const UNLOCK_SQL="SELECT pg_advisory_unlock(724106,316001)";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseArgs(args){
 const result={run:false,check:false,eventId:null,notBefore:null,bindingId:null};const seen=new Set();
 for(const arg of args){
  const key=arg.split('=')[0];if(seen.has(key))throw Error('DUPLICATE_OPTION');seen.add(key);
  if(arg==='--run')result.run=true;
  else if(arg==='--check')result.check=true;
  else if(arg.startsWith('--event-id=')&&UUID.test(arg.slice(11)))result.eventId=arg.slice(11);
  else if(arg.startsWith('--binding-id=')&&UUID.test(arg.slice(13)))result.bindingId=arg.slice(13);
  else if(arg.startsWith('--not-before=')){
   const value=arg.slice(13);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('INVALID_CUTOFF');result.notBefore=new Date(value).toISOString();
   if(result.notBefore!==value.replace(/(?<!\.\d{3})Z$/,'.000Z'))throw Error('INVALID_CUTOFF');
  }else throw Error('INVALID_OPTION');
 }
 if(result.check){if(args.length!==1)throw Error('READINESS_ONLY_OPTIONS_REQUIRED');return result;}
 if(!result.run||Boolean(result.eventId)===Boolean(result.notBefore))throw Error('EXPLICIT_SINGLE_EVENT_OR_CUTOFF_REQUIRED');
 return result;
}
class SingletonSession{
 constructor(client){this.client=client;this.held=false;this.lost=false;client.on('error',()=>{this.lost=true;this.held=false;});client.on('end',()=>{this.lost=true;this.held=false;});}
 async acquire(){if(this.lost)throw Error('LOCK_CONNECTION_LOST');if(!this.held)this.held=(await this.client.query(LOCK_SQL)).rows[0].acquired;return this.held;}
 async query(...args){if(!this.held||this.lost)throw Error('WORKER_LOCK_NOT_HELD');return this.client.query(...args);}
 // Every store operation uses the VERY SAME session as the advisory lock.
 async connect(){if(!this.held||this.lost)throw Error('WORKER_LOCK_NOT_HELD');return {query:this.query.bind(this),release(){}};}
 async close(){try{if(this.held&&!this.lost)await this.client.query(UNLOCK_SQL);}finally{this.held=false;await this.client.end();}}
}
async function inspectReadiness(client){
 await client.query('BEGIN READ ONLY');
 try{
  const backlog=(await client.query(`SELECT channel,count(*)::int AS pending_events,min(created_at) AS oldest,max(created_at) AS newest
   FROM public.android_notification_events WHERE expanded_at IS NULL AND expires_at>now() GROUP BY channel ORDER BY channel`)).rows;
  const deliveries=(await client.query(`SELECT status,count(*)::int AS count FROM public.android_notification_deliveries GROUP BY status ORDER BY status`)).rows;
  const devices=(await client.query(`SELECT count(*)::int AS registered,
   count(*) FILTER(WHERE notifications_enabled AND revoked_at IS NULL AND expires_at>now())::int AS active,
   count(*) FILTER(WHERE notifications_enabled AND revoked_at IS NULL AND expires_at>now() AND length(token_cipher)>0)::int AS active_with_encrypted_token
   FROM public.android_push_devices`)).rows[0];
  const locks=(await client.query(`SELECT count(DISTINCT pid)::int AS active_workers FROM pg_locks
   WHERE locktype='advisory' AND granted AND classid=724106 AND objid=316001 AND objsubid=2
   AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows[0];
  return {backlog,deliveries,devices,activeWorkers:locks.active_workers};
 }finally{await client.query('ROLLBACK');}
}
async function run(args,env=process.env){
 const scope=parseArgs(args);
 for(const key of ['DB_HOST','DB_NAME','DB_USER','DB_PASSWORD','DASHBOARD_USERNAME'])if(!env[key])throw Error('REQUIRED_CONFIGURATION_MISSING');
 const {firebaseConfig,database}=require('./android-push-preflight');
 if(!Object.values(firebaseConfig(env)).every(Boolean))throw Error('FIREBASE_CONFIGURATION_INVALID');
 const {Client}=require('pg');
 const client=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,
  connectionTimeoutMillis:5000,query_timeout:10000,application_name:'mehrab-fcm-singleton-worker',keepAlive:true});
 const lock=new SingletonSession(client);let stopping=false,wake;
 const stop=()=>{stopping=true;wake?.();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const pause=()=>new Promise(resolve=>{const timer=setTimeout(resolve,5000);wake=()=>{clearTimeout(timer);resolve();};});
 try{
  await client.connect();const preflight=await database(client);
  if(!preflight.compatible||!preflight.instagramNotificationReady)throw Error('DATABASE_PREFLIGHT_FAILED');
  if(scope.check){const readiness=await inspectReadiness(client);console.log(JSON.stringify({mode:'READINESS_ONLY',compatible:true,instagramReady:true,...readiness,sendingEnabled:false}));return;}
  while(!stopping&&!await lock.acquire()){console.log('FCM_WORKER_STANDBY');await pause();}
  if(stopping)return;
  console.log('FCM_WORKER_LOCK_ACQUIRED');
  const {PgAndroidPushStore}=require('./android-push-store'),{createAndroidPushService}=require('./android-push');
  const {createWorkerAccess}=require('./android-push-worker-access');
  const {AndroidPushWorker,createFirebaseSender}=require('./android-push-worker');
  const store=new PgAndroidPushStore(lock,scope),access=createWorkerAccess({pool:lock,env});
  const service=createAndroidPushService({store,...access,env});
  const send=createFirebaseSender({env,allowSend:true});
  const sender=async(...values)=>{
   if(stopping)throw Object.assign(Error('WORKER_STOPPING'),{code:'WORKER_STOPPING'});
   await lock.query('SELECT 1');if(stopping||lock.lost)throw Object.assign(Error('WORKER_STOPPING'),{code:'WORKER_STOPPING'});
   return send(...values);
  };sender.prepare=send.prepare;
  const worker=new AndroidPushWorker({store,service,sender,env,allowDispatch:true,canRun:()=>!stopping&&!lock.lost});
  while(!stopping&&!lock.lost){
   try{await worker.runOnce(50);}catch{if(lock.lost)throw Error('LOCK_CONNECTION_LOST');console.error('FCM_WORKER_CYCLE_FAILED');}
   if(!stopping&&!lock.lost)await pause();
  }
  if(lock.lost)throw Error('LOCK_CONNECTION_LOST');
 }finally{stopping=true;process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await lock.close();console.log('FCM_WORKER_STOPPED');}
}
if(require.main===module)run(process.argv.slice(2)).catch(()=>{console.error('FCM_WORKER_STOPPED_WITH_ERROR; details suppressed');process.exitCode=1;});
module.exports={parseArgs,SingletonSession,inspectReadiness,run,LOCK_SQL};
