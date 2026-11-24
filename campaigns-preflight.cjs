'use strict';
// Metadata/privileges only. No imports of workers, senders or n8n execution APIs.
const {Client}=require('pg');
async function check(env=process.env){
 if(['DB_HOST','DB_NAME','DB_USER','DB_PASSWORD'].some(k=>!env[k]))throw Error('EXPLICIT_DATABASE_ENV_REQUIRED');
 const c=new Client({host:env.DB_HOST,port:Number(env.DB_PORT||5432),database:env.DB_NAME,user:env.DB_USER,password:env.DB_PASSWORD,connectionTimeoutMillis:5000});
 try{
  await c.connect();await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='5000ms'");
  const identity=(await c.query("SELECT current_user AS role,current_database() AS database,current_setting('server_version_num')::int AS version,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS existing_superuser")).rows[0];
  const requirements={whatsapp_contact_permissions:['SELECT','INSERT','UPDATE'],whatsapp_contact_permission_audit:['SELECT','INSERT'],whatsapp_template_campaigns:['SELECT','INSERT','UPDATE'],whatsapp_template_campaign_recipients:['SELECT','INSERT','UPDATE'],whatsapp_template_delivery_events:['SELECT','INSERT'],whatsapp_template_status_inbox:['SELECT','INSERT','UPDATE']};
  const missing=[],privileges=[];
  for(const [table,ops]of Object.entries(requirements))for(const op of ops){const r=(await c.query('SELECT to_regclass($1) IS NOT NULL AS installed,has_table_privilege(current_user,to_regclass($1),$2) AS allowed',['public.'+table,op])).rows[0];if(!r.installed&&!missing.includes(table))missing.push(table);privileges.push({table,operation:op,allowed:r.allowed===true});}
  const sequence=(await c.query("SELECT COALESCE(has_sequence_privilege(current_user,to_regclass('public.whatsapp_contact_permission_audit_id_seq'),'USAGE'),false) AS ok")).rows[0].ok;
  await c.query('ROLLBACK');
  const databaseReady=identity.version>=180000&&!missing.length&&privileges.every(p=>p.allowed)&&sequence,phoneAccountConfigured=env.WHATSAPP_PHONE_NUMBER_ID==='1053675661167480';
  return {ready:databaseReady&&phoneAccountConfigured,databaseReady,identity,missingTables:missing,privileges,auditSequenceUsage:sequence,flags:{ui:env.WHATSAPP_CAMPAIGNS_ENABLED==='true',sending:env.WHATSAPP_CAMPAIGNS_WORKER_ENABLED==='true',receipts:env.WHATSAPP_CAMPAIGN_STATUS_WORKER_ENABLED==='true'},phoneAccountConfigured,productionWrites:false};
 }finally{await c.end();}
}
if(require.main===module){if(!process.argv.includes('--database')){console.error('EXPLICIT_READONLY_DATABASE_CHECK_REQUIRED');process.exitCode=1;}else check().then(r=>{console.log(JSON.stringify(r));if(!r.ready)process.exitCode=2;}).catch(()=>{console.error(JSON.stringify({ready:false,error:'PREFLIGHT_FAILED_DETAILS_SUPPRESSED',productionWrites:false}));process.exitCode=1;});}
module.exports={check};
