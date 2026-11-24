'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {CampaignConversations}=require('../whatsapp-campaign-conversations'),{StatusInbox}=require('../whatsapp-template-status-inbox');
module.exports=({getPool,getService,grant,body,row,admin})=>{
 async function canonical(d,number='12025550101'){
  const r=d.recipients.find(r=>r.phone===number),mid='wamid.'+r.id;
  return (await getPool().query("INSERT INTO chat_memory(session_id,message) VALUES($1,$2) RETURNING id",[number,{type:'agent',content:'Synthetic bulk message',wa_message_id:mid,campaign_id:d.campaign.id,campaign_title:d.campaign.title,campaign_bulk:d.campaign.is_bulk,campaign_recipient_id:r.id}])).rows[0].id;
 }
 const normal=async()=> (await getPool().query("SELECT * FROM(SELECT DISTINCT ON(session_id) session_id,id FROM chat_memory WHERE NOT(COALESCE(message->>'type','')='agent' AND COALESCE(message->>'campaign_bulk','false')='true') ORDER BY session_id,id DESC)n ORDER BY id DESC")).rows;
 test('canonical sender stores campaign identity once, preserves AI and canonical conversation',async()=>{
  const pool=getPool(),service=getService();await grant();await grant('12025550102');const d=await service.prepare(admin,body([row(),row('12025550102')]),randomUUID());
  await pool.query("INSERT INTO chat_sessions(session_id,ai_enabled) VALUES('12025550101',true)");
  await service.control(admin,d.campaign.id,'confirm',d.reviewToken);await service.tick();const q=(await pool.query('SELECT * FROM dashboard_send_queue')).rows[0];
  await pool.query("UPDATE dashboard_send_queue SET state='sending',payload=payload||'{\"templateDispatchClaimed\":true}'");
  const sql=fs.readFileSync('D:/AlMehrab/whatsapp-templates-catalog-n8n/campaign-save-message.sql','utf8'),m={type:'agent',content:'Synthetic',wa_message_id:'wamid.SQL'};
  await pool.query(sql,[q.session_id,m,m.wa_message_id,q.id]);await pool.query(sql,[q.session_id,m,m.wa_message_id,q.id]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_memory')).rows[0].n,1);
  assert.equal((await pool.query('SELECT message FROM chat_memory')).rows[0].message.campaign_id,d.campaign.id);
  assert.equal((await pool.query('SELECT ai_enabled FROM chat_sessions')).rows[0].ai_enabled,true);
 });
 test('bulk-only numbers stay outside normal list; old and active chats keep order until actual customer reply',async()=>{
  const pool=getPool(),service=getService();await pool.query("INSERT INTO chat_memory(session_id,message) VALUES('12025550102','{\"type\":\"user\",\"content\":\"old\"}'),('12025550101','{\"type\":\"agent\",\"content\":\"individual\"}')");
  const before=await normal(),d=await service.prepare(admin,body([row(),row('12025550102'),row('12025550103')]),randomUUID());
  for(const r of d.recipients)await canonical(d,r.phone);assert.deepEqual(await normal(),before);
  await pool.query("INSERT INTO chat_memory(session_id,message) VALUES('12025550103','{\"type\":\"user\",\"content\":\"new response\"}')");
  const after=await normal();assert.equal(after[0].session_id,'12025550103');assert.equal(after.length,3);
  const list=await new CampaignConversations(service).list({campaign:d.campaign.id,filter:'replied'});assert.equal(list.total,1);assert.equal(list.rows[0].response,'after_send');assert.equal(list.rows[0].unread_count,1);
 });
 test('existing individual template SQL remains visible and keeps its original AI-disable behavior',async()=>{
  const pool=getPool(),sql=fs.readFileSync('D:/AlMehrab/whatsapp-templates-catalog-n8n/campaign-save-message.sql','utf8'),mid='wamid.INDIVIDUAL';
  await pool.query(sql,['12025550101',{type:'agent',content:'Synthetic individual',wa_message_id:mid},mid,randomUUID()]);
  const m=(await pool.query('SELECT message FROM chat_memory')).rows[0].message;
  assert.equal(m.campaign_id,undefined);assert.equal((await normal()).length,1);
  assert.equal((await pool.query('SELECT ai_enabled FROM chat_sessions')).rows[0].ai_enabled,false);
 });
 test('past messages never count; overlapping campaigns stay ambiguous unless same-phone exact Reply MID resolves them',async()=>{
  const pool=getPool(),service=getService();await pool.query("INSERT INTO chat_memory(session_id,message) VALUES('12025550101','{\"type\":\"user\"}')");
  const a=await service.prepare(admin,body(),randomUUID());await canonical(a);const b=await service.prepare(admin,body(),randomUUID());await canonical(b);
  await pool.query("INSERT INTO chat_memory(session_id,message) VALUES('12025550101','{\"type\":\"user\",\"timestamp\":\"2020-01-01T00:00:00Z\"}')");
  const priorCheck=new CampaignConversations(service);assert.equal((await priorCheck.list({campaign:a.campaign.id,filter:'replied'})).total,0);
  await pool.query("INSERT INTO chat_memory(session_id,message) VALUES('12025550101','{\"type\":\"user\",\"content\":\"ambiguous\"}')");
  const api=new CampaignConversations(service);
  assert.equal((await api.list({campaign:a.campaign.id,filter:'replied'})).total,0);
  assert.equal((await api.list({campaign:a.campaign.id,filter:'not_replied'})).total,0);
  assert.equal((await api.list({campaign:a.campaign.id,filter:'ambiguous'})).total,1);
  assert.equal((await api.list()).total,1);
  await pool.query('INSERT INTO chat_memory(session_id,message) VALUES($1,$2)',['12025550101',{type:'user',reply_to:{external_message_id:'wamid.'+a.recipients[0].id}}]);
  assert.equal((await api.list({campaign:a.campaign.id,filter:'replied'})).rows[0].response,'explicit');
  assert.equal((await api.list({campaign:b.campaign.id,filter:'replied'})).total,0);
  await pool.query("INSERT INTO chat_sessions(session_id,last_read_message_id) SELECT '12025550101',max(id) FROM chat_memory");
  assert.equal((await api.list({campaign:a.campaign.id,filter:'unread'})).total,0);
 });
 test('durable receipt intake survives restart, concurrent drain and repeated failed-child recovery without a send',async()=>{
  const pool=getPool(),env={WHATSAPP_PHONE_NUMBER_ID:'12345'},event={phoneNumberId:'12345',messageId:'wamid.RECEIPT',phone:'12025550101',status:'read',timestamp:'1795480000'};
  const s=new StatusInbox({pool,env});await s.put(event);await s.put(event);const second=new StatusInbox({pool,env});await Promise.all([s.drain(),second.drain()]);await second.drain();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM whatsapp_template_delivery_events')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM whatsapp_template_status_inbox WHERE processed_at IS NULL')).rows[0].n,0);
  const calls=[],recovery=new StatusInbox({pool,env:{...env,N8N_STATUS_RECOVERY_URL:'https://n8n.example.invalid',N8N_STATUS_RECOVERY_TOKEN:'SYNTHETIC',N8N_STATUS_CHILD_ID:'SYNTHETIC-CHILD'},fetchImpl:async(u,o)=>{calls.push(o.method);return {ok:true,json:async()=>String(u).includes('/executions/9?')?{workflowId:'SYNTHETIC-CHILD',status:'error',data:{resultData:{runData:{'Normalize Status Metadata Only':[{data:{main:[[{json:event}]]}}]}}}}:{data:[{id:9,workflowId:'SYNTHETIC-CHILD'}]}};}});
  await recovery.recover();await recovery.recover();await recovery.drain();assert(calls.every(m=>m==='GET'));assert.equal((await pool.query('SELECT count(*)::int AS n FROM whatsapp_template_delivery_events')).rows[0].n,1);
 });
 test('10000 recipients: bounded pages, whole-dataset search and no normal-list promotion',async()=>{
  const pool=getPool(),service=getService(),d=await service.prepare(admin,body(),randomUUID());
  await pool.query(`INSERT INTO whatsapp_template_campaign_recipients(id,campaign_id,phone,name,eligible,queue_request_id) SELECT gen_random_uuid(),$1,('1202556'||lpad(i::text,4,'0')),'Synthetic '||i,true,gen_random_uuid() FROM generate_series(0,9999)i`,[d.campaign.id]);
  await pool.query(`INSERT INTO chat_memory(session_id,message) SELECT phone,jsonb_build_object('type','agent','content','synthetic','campaign_bulk',true,'campaign_id',campaign_id,'campaign_recipient_id',id,'wa_message_id',id::text) FROM whatsapp_template_campaign_recipients WHERE campaign_id=$1`,[d.campaign.id]);
  const started=Date.now(),api=new CampaignConversations(service),page=await api.list({campaign:d.campaign.id,offset:9950}),search=await api.list({campaign:d.campaign.id,q:'Synthetic 9999'});
  assert.equal(page.rows.length,50);assert.equal(page.total,10001);assert.equal(search.total,1);assert.equal((await normal()).length,0);
  const elapsed=Date.now()-started;console.log('SYNTHETIC_CAMPAIGN_10000_QUERY_MS='+elapsed);assert(elapsed<15000);
  const {historyPage}=require('../whatsapp-campaign-history'),history=await historyPage(pool,d.campaign.id,{offset:9950}),filtered=await historyPage(pool,d.campaign.id,{q:'Synthetic 9999'});
  assert.equal(history.recipients.length,50);assert.equal(history.summary.total,10001);assert.equal(filtered.pagination.total,1);assert.equal(filtered.recipients[0].conversation_available,true);
  const meta=await api.group(d.campaign.id);assert.equal(meta.recipients,10001);assert.equal(meta.title,d.campaign.title);
 });
 test('private backup helper encrypts and fully restores synthetic PostgreSQL18 archive on another authenticated loopback cluster',async()=>{
  const pool=getPool(),folder=path.join(process.env.USERPROFILE,'.codex/backups/postgres','campaign-SYNTHETIC-'+randomUUID());fs.mkdirSync(folder,{recursive:true});
  const sid=spawnSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).stdout.match(/S-1-5-[0-9-]+/)[0];
  const acl=spawnSync('icacls.exe',[folder,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'/grant:r','*S-1-5-18:(OI)(CI)F'],{windowsHide:true});assert.equal(acl.status,0);
  const dump=spawnSync(path.join(process.env.LOCAL_PG18_BIN,'pg_dump.exe'),['-h','127.0.0.1','-p',String(pool.options.port),'-U','synthetic','-Fc','postgres'],{windowsHide:true,maxBuffer:20e6});assert.equal(dump.status,0);fs.writeFileSync(path.join(folder,'dashboard.dump'),dump.stdout);
  const restored=spawnSync(process.execPath,['D:/AlMehrab/whatsapp-campaigns-review/restore-private-backup.mjs',folder],{windowsHide:true,encoding:'utf8',maxBuffer:100000,timeout:60000});assert.equal(restored.status,0,restored.stdout+restored.stderr);
  const result=JSON.parse(restored.stdout.trim());assert.equal(result.status,'PRIVATE_BACKUP_AND_ISOLATED_FULL_RESTORE_VERIFIED');assert.equal(result.productionWrites,false);
 });
};
