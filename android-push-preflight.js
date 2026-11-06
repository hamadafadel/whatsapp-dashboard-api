'use strict';
// Operator-run read-only preflight. Never imports server.js or starts a notification worker.
const fs=require('fs'),crypto=require('crypto');
function firebaseConfig(env=process.env){
 const key=env.ANDROID_PUSH_TOKEN_ENCRYPTION_KEY||'';
 const encryptionKeyValid=Buffer.from(key,'base64').length===32&&Buffer.from(key,'base64').toString('base64')===key;
 let serviceAccountValid=false;
 try{const account=JSON.parse(fs.readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS,'utf8'));
  serviceAccountValid=account.type==='service_account'&&account.project_id===env.FIREBASE_PROJECT_ID&&typeof account.client_email==='string'&&crypto.createPrivateKey(account.private_key).asymmetricKeyType==='rsa';
 }catch{}
 return {projectConfigured:env.FIREBASE_PROJECT_ID==='al-mehrab-dashboard-231aa',encryptionKeyValid,serviceAccountValid};
}
async function database(c){
 await c.query('BEGIN READ ONLY');
 try{
  const version=Number((await c.query("SELECT current_setting('server_version_num') version")).rows[0].version);
  const columns=(await c.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='chat_memory' ORDER BY ordinal_position")).rows;
  const id=columns.find(c=>c.column_name==='id'),message=columns.find(c=>c.column_name==='message');
  const canonical=(await c.query("SELECT pg_get_function_result(to_regprocedure('public.upsert_messenger_chat_message(text,text,text,jsonb)')) result")).rows[0].result;
  const permissions=(await c.query("SELECT has_schema_privilege('public','USAGE') schema_usage,has_table_privilege('public.chat_memory','SELECT') message_select,has_table_privilege('public.chat_memory','INSERT') message_insert,has_table_privilege('public.chat_memory','UPDATE') message_update,has_function_privilege('public.upsert_messenger_chat_message(text,text,text,jsonb)','EXECUTE') canonical_access,CASE WHEN pg_get_serial_sequence('public.chat_memory','id') IS NULL THEN true ELSE has_sequence_privilege(pg_get_serial_sequence('public.chat_memory','id'),'USAGE') END sequence_usage,EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid='public.chat_memory'::regclass AND i.indisunique AND i.indisvalid AND i.indnkeyatts=1 AND i.indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.chat_memory'::regclass AND attname='id')) id_unique")).rows[0];
  const existing=(await c.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (relname LIKE 'android_push_%' OR relname LIKE 'android_notification_%') ORDER BY relname")).rows.map(r=>r.relname);
  const functions=(await c.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname IN ('enqueue_android_incoming_notification','save_android_notified_whatsapp_user_message','save_android_notified_messenger_user_message','prepare_android_instagram_notification') ORDER BY proname")).rows.map(r=>r.proname);
  const instagram=(await c.query("SELECT COALESCE(has_table_privilege(to_regclass('public.chat_sessions'),'SELECT'),false) AND COALESCE(has_table_privilege(to_regclass('public.chat_sessions'),'INSERT'),false) AND COALESCE(has_table_privilege(to_regclass('public.rate_limit'),'SELECT'),false) AND COALESCE(has_table_privilege(to_regclass('public.rate_limit'),'INSERT'),false) AND COALESCE(has_table_privilege(to_regclass('public.rate_limit'),'UPDATE'),false) save_prerequisites,EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.android_notification_events') AND conname='android_notification_events_channel_check' AND pg_get_constraintdef(oid) LIKE '%instagram%') channel_ready,EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.android_notification_events') AND conname='android_notification_events_origin_check' AND pg_get_constraintdef(oid) LIKE '%live_instagram_webhook%') origin_ready")).rows[0];
  const igPrivileges=(await c.query("SELECT COALESCE(has_function_privilege(to_regprocedure('public.prepare_android_instagram_notification(text,text,text,jsonb,text)'),'EXECUTE'),false) factory_execute,COALESCE(has_table_privilege(to_regclass('public.android_notification_events'),'INSERT'),false) event_insert")).rows[0];
  const compatible=version>=130000&&['integer','bigint'].includes(id?.data_type)&&message?.data_type==='jsonb'&&columns.some(c=>c.column_name==='session_id')&&columns.some(c=>c.column_name==='created_at')&&
   /id bigint, message jsonb, operation text, canonical_source text/.test(canonical||'')&&Object.values(permissions).every(Boolean)&&instagram.save_prerequisites;
  return {version,compatible,permissions,instagramSavePrerequisites:instagram.save_prerequisites,
   instagramNotificationReady:Boolean(instagram.channel_ready&&instagram.origin_ready&&functions.includes('prepare_android_instagram_notification')&&igPrivileges.factory_execute&&igPrivileges.event_insert),
   existingNotificationObjects:existing,existingNotificationFunctions:functions,migrationNotYetApplied:existing.length===0&&functions.length===0};
 }finally{await c.query('ROLLBACK');}
}
if(require.main===module)(async()=>{
 const result={firebase:firebaseConfig()};let client;
 try{
  if(process.argv.includes('--database')){
   if(!['DB_HOST','DB_NAME','DB_USER','DB_PASSWORD'].every(k=>process.env[k]))throw Error('DATABASE_CONFIG_MISSING');
   const {Client}=require('pg');client=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    connectionTimeoutMillis:5000,statement_timeout:5000,options:'-c default_transaction_read_only=on',application_name:'ANDROID_PUSH_PREFLIGHT_READ_ONLY'});
   await client.connect();result.database=await database(client);
  }
  console.log(JSON.stringify(result));if(!Object.values(result.firebase).every(Boolean)||result.database&&!result.database.compatible||process.argv.includes('--require-instagram')&&!result.database?.instagramNotificationReady)process.exitCode=1;
 }catch{console.error('ANDROID_PUSH_PREFLIGHT_FAILED; no secrets printed');process.exitCode=1;}finally{await client?.end();}
})();
module.exports={firebaseConfig,database};
