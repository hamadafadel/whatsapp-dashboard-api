'use strict';
const {randomUUID,createHash,timingSafeEqual}=require('node:crypto');
const {phone,parseFile}=require('./whatsapp-campaign-import');
const {templateTools}=require('./whatsapp-template-payload');
const {templateRevision}=require('./whatsapp-template-catalog');
const {fault}=require('./send-queue');
const {enrich,summarize,xlsxReport}=require('./whatsapp-campaign-report');
const {CampaignConversations}=require('./whatsapp-campaign-conversations');
const {historyPage}=require('./whatsapp-campaign-history');
const directoryTools=require('./whatsapp-campaign-directory');
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function mergeRows(input,country){
  if(!Array.isArray(input)||!input.length||input.length>10000)throw fault('RECIPIENT_LIMIT',422);
  const rows=new Map();
  for(const x of input){
    const number=phone(x.phone,country),values=x.values||{};
    if(!values||Array.isArray(values)||typeof values!=='object'||Object.values(values).some(v=>typeof v!=='string'||v.length>4096))throw fault('INVALID_VALUES',422);
    const sources=Array.isArray(x.sources)?x.sources.filter(s=>typeof s==='string'&&s.length<=120).slice(0,30):['manual'];
    const before=rows.get(number),ordered=Object.fromEntries(Object.entries(values).sort(([a],[b])=>a.localeCompare(b)));
    if(before){
      if(hash(before.values)!==hash(ordered))throw fault('DUPLICATE_RECIPIENT_VALUE_CONFLICT',409);
      before.sources=[...new Set([...before.sources,...sources])];
    }else rows.set(number,{phone:number,name:String(x.name||'').slice(0,160),sources,values:ordered});
  }
  return [...rows.values()].sort((a,b)=>a.phone.localeCompare(b.phone));
}
function consentReason(record,category){
  if(record?.status==='withdrawn')return 'OPTED_OUT';
  if(record?.status!=='granted'||!record.categories?.includes(category))return 'CONSENT_REQUIRED';
  return null;
}
class Campaigns {
  constructor({pool,catalog,dynamic,queueStore,queue,account,canAccess,env=process.env}){Object.assign(this,{pool,catalog,dynamic,queueStore,queue,account,canAccess,env});this.timer=null;this.busy=false;}
  enabled(){return this.env.WHATSAPP_CAMPAIGNS_ENABLED==='true';}
  testLimited(){return this.env.WHATSAPP_CAMPAIGNS_TEST_MODE!=='false';}
  testRecipients(rows){if(this.testLimited()&&(!Array.isArray(rows)||rows.length!==1||rows[0].phone!=='201114438440'))throw fault('CAMPAIGN_TEST_RECIPIENT_ONLY',403);}
  async testCampaign(c,id){
    if(!this.testLimited())return;
    const campaigns=(await c.query('SELECT id FROM public.whatsapp_template_campaigns ORDER BY created_at,id LIMIT 2')).rows;
    if(campaigns.length!==1||campaigns[0].id!==id)throw fault('CAMPAIGN_TEST_SINGLE_OPERATION_ONLY',403);
    this.testRecipients((await c.query('SELECT phone FROM public.whatsapp_template_campaign_recipients WHERE campaign_id=$1',[id])).rows);
  }
  async ready(){await this.pool.query('SELECT id FROM public.whatsapp_template_campaigns LIMIT 0');}
  async admin(user){const actual=user?.username&&this.account(user.username);if(!actual||actual.role!=='admin')throw fault('ADMINS_ONLY',403);return actual;}
  async permissions(numbers){return new Map((await this.pool.query('SELECT phone,status,categories FROM public.whatsapp_contact_permissions WHERE phone=ANY($1::text[])',[numbers])).rows.map(r=>[r.phone,r]));}
  async resolve(rows,country){
    if(!Array.isArray(rows)||rows.length>10000)throw fault('RECIPIENT_LIMIT',422);
    const normalized=rows.map((r,i)=>{try{return {...r,phone:phone(r.phone,country),inputIndex:i};}catch{return {...r,phone:'',inputIndex:i,reason:'INVALID_WHATSAPP_NUMBER'};}});
    const phones=normalized.map(r=>r.phone).filter(Boolean),perms=await this.permissions(phones),names=await directoryTools.names(this.pool,phones);
    return {rows:normalized.map(r=>({phone:r.phone,name:names.get(r.phone)||String(r.name||'').slice(0,160),inputIndex:r.inputIndex,reason:r.reason||null,permission:perms.get(r.phone)||null}))};
  }
  async labels(ids,q='',offset=0,limit=100){
    if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(x=>!Number.isSafeInteger(x)||x<1))throw fault('INVALID_LABELS',422);
    if(typeof q!=='string'||q.length>120)throw fault('INVALID_SEARCH',422);
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw fault('INVALID_PAGE',422);
    // Label IDs, not label names. UNION semantics; don't turn fb:/ig: identifiers into phone numbers.
    const r=await this.pool.query(`WITH members AS (
      SELECT DISTINCT a.session_id FROM public.conversation_label_assignments a
      JOIN public.conversation_labels l ON l.id=a.label_id WHERE a.label_id=ANY($1::int[])
    ), names AS (
      SELECT m.session_id AS phone,COALESCE(n.name,'') AS name
      FROM members m LEFT JOIN LATERAL (SELECT message->>'customer_name' AS name FROM public.chat_memory
        WHERE session_id=m.session_id AND COALESCE(message->>'customer_name','')<>'' ORDER BY id DESC LIMIT 1) n ON true
      WHERE m.session_id ~ '^[1-9][0-9]{6,14}$'
    ) SELECT *,count(*) OVER()::int AS total FROM names
      WHERE $2='' OR position(lower($2) IN lower(name))>0 OR position($2 IN phone)>0
      ORDER BY name,phone LIMIT $3 OFFSET $4`,[ids,q,limit,offset]);
    const resolved=await this.resolve(r.rows);
    const tags=(await this.pool.query(`SELECT a.session_id,l.id,l.name,l.color FROM public.conversation_label_assignments a JOIN public.conversation_labels l ON l.id=a.label_id WHERE a.label_id=ANY($1::int[]) AND a.session_id=ANY($2::text[]) ORDER BY l.id`,[ids,r.rows.map(x=>x.phone)])).rows;
    return {...resolved,rows:resolved.rows.map(x=>({...x,labels:tags.filter(t=>t.session_id===x.phone).map(({session_id,...t})=>t)})),total:r.rows[0]?.total||0,offset,limit};
  }
  async consent(user,b){
    const n=phone(b.phone),categories=b.categories;
    if(!['granted','withdrawn'].includes(b.status)||!Array.isArray(categories)||!categories.length||categories.some(c=>!['MARKETING','UTILITY','AUTHENTICATION'].includes(c))||typeof b.evidence!=='string'||b.evidence.trim().length<5||b.evidence.length>1000)throw fault('CONSENT_EVIDENCE_REQUIRED',422);
    const c=await this.pool.connect();try{
      await c.query('BEGIN');
      await c.query('INSERT INTO public.whatsapp_contact_permissions(phone,status,categories,evidence,recorded_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(phone) DO UPDATE SET status=EXCLUDED.status,categories=EXCLUDED.categories,evidence=EXCLUDED.evidence,recorded_by=EXCLUDED.recorded_by,updated_at=now()',[n,b.status,[...new Set(categories)],b.evidence.trim(),user.username]);
      await c.query('INSERT INTO public.whatsapp_contact_permission_audit(phone,status,categories,evidence,recorded_by) VALUES($1,$2,$3,$4,$5)',[n,b.status,categories,b.evidence.trim(),user.username]);
      await c.query('COMMIT');return {saved:true};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async definition(b){
    const data=await this.catalog.list({fresh:true}),t=data.templates.find(t=>t.id===b.templateId&&t.language===b.language);
    if(!t||t.status!=='APPROVED')throw fault('TEMPLATE_NO_LONGER_APPROVED',422);
    if(templateRevision(t)!==b.revision)throw fault('TEMPLATE_CHANGED_REFRESH_REQUIRED',409);
    if(!templateTools().plan(t).supported)throw fault('UNSUPPORTED_TEMPLATE_COMPONENT',422);
    return t;
  }
  async prepare(user,b,requestId){
    const testRows=mergeRows(b.recipients,b.country);this.testRecipients(testRows);
    if(!uuid(requestId)||typeof b.title!=='string'||!b.title.trim()||b.title.length>120)throw fault('CAMPAIGN_TITLE_AND_KEY_REQUIRED',422);
    if(!Array.isArray(b.excludePhones||[]))throw fault('INVALID_EXCLUSIONS',422);
    const t=await this.definition(b),rows=mergeRows(b.recipients,b.country),perms=await this.permissions(rows.map(r=>r.phone)),excluded=new Set(b.excludePhones||[]);
    if([...excluded].some(n=>!rows.some(r=>r.phone===n)))throw fault('INVALID_EXCLUSIONS',422);
    for(const r of rows){
      if(!await this.canAccess(user,r.phone))throw fault('RECIPIENT_ACCESS_DENIED',403);
      templateTools().compile(t,r.values);r.reason=excluded.has(r.phone)?'USER_EXCLUDED':consentReason(perms.get(r.phone),t.category);r.eligible=!r.reason;
    }
    const interval=Number(b.intervalMs||2000);if(!Number.isSafeInteger(interval)||interval<1000||interval>60000)throw fault('INVALID_RATE',422);
    const fingerprint=hash({title:b.title.trim(),templateId:t.id,language:t.language,revision:b.revision,interval,excludePhones:[...excluded].sort(),rows:rows.map(({eligible,reason,...r})=>r)});
    const c=await this.pool.connect();try{
      await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('wa-campaign:'||$1||':'||$2,0))",[user.username,requestId]);
      if(this.testLimited()){
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended('wa-campaign-single-test-v1',0))");
        const existing=(await c.query('SELECT owner_name,request_id FROM public.whatsapp_template_campaigns LIMIT 1')).rows[0];
        if(existing&&(existing.owner_name!==user.username||existing.request_id!==requestId))throw fault('CAMPAIGN_TEST_SINGLE_OPERATION_ONLY',403);
      }
      const old=(await c.query('SELECT id,fingerprint FROM public.whatsapp_template_campaigns WHERE owner_name=$1 AND request_id=$2',[user.username,requestId])).rows[0];
      if(old){if(old.fingerprint!==fingerprint)throw fault('IDEMPOTENCY_CONFLICT',409);await c.query('COMMIT');return this.detail(old.id);}
      const id=randomUUID();await c.query('INSERT INTO public.whatsapp_template_campaigns(id,owner_name,request_id,fingerprint,title,template,revision,interval_ms,is_bulk) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,user.username,requestId,fingerprint,b.title.trim(),t,b.revision,interval,rows.length>1]);
      for(const r of rows)await c.query('INSERT INTO public.whatsapp_template_campaign_recipients(id,campaign_id,phone,name,sources,values,eligible,reason,state,queue_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),id,r.phone,r.name,JSON.stringify(r.sources),r.values,r.eligible,r.reason,r.eligible?'pending':'excluded',randomUUID()]);
      await c.query('COMMIT');return this.detail(id);
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async detail(id){
    if(!uuid(id))throw fault('INVALID_CAMPAIGN_ID',422);
    const campaign=(await this.pool.query('SELECT * FROM public.whatsapp_template_campaigns WHERE id=$1',[id])).rows[0];if(!campaign)throw fault('CAMPAIGN_NOT_FOUND',404);
    const recipients=(await this.pool.query(`SELECT r.*,EXISTS(SELECT 1 FROM public.chat_memory m WHERE m.session_id=r.phone) AS conversation_available,q.state AS queue_state,q.reason AS queue_reason,q.updated_at AS queue_updated_at,q.result->>'messageId' AS confirmed_mid,
      d.status AS delivery_status,d.event_at AS delivery_at,d.error_code AS delivery_error_code
      FROM public.whatsapp_template_campaign_recipients r LEFT JOIN public.dashboard_send_queue q ON q.owner_name=$2 AND q.request_id=r.queue_request_id::text
      LEFT JOIN LATERAL (SELECT d.status,d.event_at,d.error_code FROM public.whatsapp_template_delivery_events d WHERE d.message_id=COALESCE(q.result->>'messageId',r.message_id) AND d.phone=r.phone
        ORDER BY CASE d.status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END DESC,d.event_at DESC LIMIT 1) d ON true
      WHERE r.campaign_id=$1 ORDER BY r.phone`,[id,campaign.owner_name])).rows;
    const result=recipients.map(r=>enrich(r,campaign));
    return {campaign,recipients:result,summary:summarize(result),reviewToken:campaign.fingerprint,eligible:recipients.filter(r=>r.eligible).length,costEstimate:null};
  }
  async review(user,id,token,excludePhones=[]){
    if(!Array.isArray(excludePhones)||excludePhones.length>10000)throw fault('INVALID_EXCLUSIONS',422);
    const before=await this.detail(id);await this.definition({templateId:before.campaign.template.id,language:before.campaign.template.language,revision:before.campaign.revision});
    const c=await this.pool.connect();try{
      await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('wa-campaign-scheduler-v1',0))");
      const campaign=(await c.query('SELECT * FROM public.whatsapp_template_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(campaign.state!=='draft')throw fault('CAMPAIGN_NOT_DRAFT',409);if(campaign.fingerprint!==token)throw fault('REVIEW_STALE_REFRESH_REQUIRED',409);
      const rows=(await c.query('SELECT * FROM public.whatsapp_template_campaign_recipients WHERE campaign_id=$1 ORDER BY phone FOR UPDATE',[id])).rows;
      if(excludePhones.some(n=>!rows.some(r=>r.phone===n)))throw fault('INVALID_EXCLUSIONS',422);
      const perms=new Map((await c.query('SELECT * FROM public.whatsapp_contact_permissions WHERE phone=ANY($1::text[])',[rows.map(r=>r.phone)])).rows.map(r=>[r.phone,r]));
      for(const r of rows){const reason=excludePhones.includes(r.phone)||r.reason==='USER_EXCLUDED'?'USER_EXCLUDED':!await this.canAccess(user,r.phone)?'SEND_PERMISSION_REVOKED':consentReason(perms.get(r.phone),campaign.template.category);r.eligible=!reason;r.reason=reason;
        await c.query("UPDATE public.whatsapp_template_campaign_recipients SET eligible=$2,reason=$3,state=$4,updated_at=CASE WHEN eligible IS DISTINCT FROM $2 OR reason IS DISTINCT FROM $3 THEN now() ELSE updated_at END WHERE id=$1",[r.id,r.eligible,reason,r.eligible?'pending':'excluded']);}
      const fingerprint=hash({requestId:campaign.request_id,revision:campaign.revision,rows:rows.map(r=>[r.id,r.eligible,r.reason,r.values])});
      await c.query('UPDATE public.whatsapp_template_campaigns SET fingerprint=$2 WHERE id=$1',[id,fingerprint]);await c.query('COMMIT');return this.detail(id);
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async control(user,id,action,token){
    if(action==='confirm'||action==='resume')await this.testCampaign(this.pool,id);
    const d=await this.detail(id);if(action==='confirm'){
      if(d.campaign.state!=='draft'){if(d.campaign.confirmed_at&&d.reviewToken===token&&d.campaign.state!=='cancelled')return d;throw fault('CAMPAIGN_NOT_DRAFT',409);}
      if(token!==d.reviewToken||!d.eligible)throw fault('REVIEW_REQUIRED_OR_NO_ELIGIBLE_RECIPIENTS',409);
      if(!this.dynamic.enabled())throw fault('DYNAMIC_TEMPLATE_NOT_CONFIGURED');
      await this.definition({templateId:d.campaign.template.id,language:d.campaign.template.language,revision:d.campaign.revision});
    }
    const transitions={confirm:['draft','running'],pause:['running','paused'],resume:['paused','running'],cancel:['draft','cancelled']};
    const c=await this.pool.connect();try{
    await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('wa-campaign-scheduler-v1',0))");
    if(action==='confirm'){
      const current=(await c.query('SELECT state,fingerprint,confirmed_at FROM public.whatsapp_template_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(current.fingerprint!==token)throw fault('REVIEW_STALE_REFRESH_REQUIRED',409);
      if(current.state!=='draft'){
        if(current.confirmed_at&&current.state!=='cancelled'){await c.query('COMMIT');return this.detail(id);}
        throw fault('CAMPAIGN_NOT_DRAFT',409);
      }
    }
    if(action==='cancel')await c.query("UPDATE public.whatsapp_template_campaigns SET state='cancelled' WHERE id=$1 AND state IN ('draft','paused','running')",[id]);
    else {const p=transitions[action];if(!p)throw fault('INVALID_ACTION',422);
      if(action==='resume'){
        const unknown=d.recipients.some(r=>r.queue_state==='unknown'||r.state==='unknown');if(unknown)throw fault('UNKNOWN_SEND_REQUIRES_REVIEW',409);
        if(!this.dynamic.enabled())throw fault('DYNAMIC_TEMPLATE_NOT_CONFIGURED');
      }
      await c.query('UPDATE public.whatsapp_template_campaigns SET state=$2,confirmed_at=COALESCE(confirmed_at,now()) WHERE id=$1 AND state=$3',[id,p[1],p[0]]);
    }await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    return this.detail(id);
  }
  async list(offset=0){if(!Number.isSafeInteger(offset)||offset<0)throw fault('INVALID_PAGE',422);const counts=(await this.pool.query("SELECT (SELECT count(*)::int FROM public.whatsapp_template_campaigns) AS campaigns,(SELECT count(*)::int FROM public.dashboard_send_queue WHERE payload ? 'dynamicTemplate' AND NOT(payload ? 'campaignRecipientId')) AS direct")).rows[0];return {offset,limit:50,hasMore:Math.max(counts.campaigns,counts.direct)>offset+50,campaigns:(await this.pool.query(`SELECT c.id,c.title,c.state,c.created_at,c.template->>'name' AS template_name,count(r.id)::int AS total,
    count(*) FILTER(WHERE e.status IN ('sent','delivered','read'))::int AS sent,
    count(*) FILTER(WHERE e.status IN ('pending','queued','sending'))::int AS remaining,
    count(*) FILTER(WHERE e.status='excluded')::int AS excluded,
    count(*) FILTER(WHERE e.status='failed')::int AS failed,
    count(*) FILTER(WHERE e.status='unknown')::int AS unknown,
    count(*) FILTER(WHERE e.status IN ('delivered','read'))::int AS delivered,
    count(*) FILTER(WHERE e.status='read')::int AS read
    FROM public.whatsapp_template_campaigns c LEFT JOIN public.whatsapp_template_campaign_recipients r ON r.campaign_id=c.id
    LEFT JOIN public.dashboard_send_queue q ON q.owner_name=c.owner_name AND q.request_id=r.queue_request_id::text
    LEFT JOIN LATERAL (SELECT d.status FROM public.whatsapp_template_delivery_events d WHERE d.message_id=COALESCE(q.result->>'messageId',r.message_id) AND d.phone=r.phone ORDER BY CASE d.status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END DESC,d.event_at DESC LIMIT 1) d ON true
    LEFT JOIN LATERAL (SELECT CASE WHEN COALESCE(q.state,r.state)='cancelled' OR(c.state='cancelled' AND COALESCE(q.state,r.state)='pending') THEN 'excluded' ELSE COALESCE(d.status,q.state,r.state) END AS status) e ON true
    WHERE c.id IN (SELECT id FROM public.whatsapp_template_campaigns ORDER BY created_at DESC LIMIT 50 OFFSET $1)
    GROUP BY c.id ORDER BY c.created_at DESC`,[offset])).rows,
    direct:(await this.pool.query(`SELECT q.id,q.session_id,q.session_id AS phone,q.owner_name,q.state,q.reason,q.created_at,q.updated_at,q.payload->'dynamicTemplate'->>'templateId' AS template_id,
      d.status AS delivery_status,d.event_at AS delivery_at,d.error_code AS delivery_error_code,n.name
      FROM public.dashboard_send_queue q LEFT JOIN LATERAL (SELECT d.status,d.event_at,d.error_code FROM public.whatsapp_template_delivery_events d WHERE d.message_id=q.result->>'messageId' AND d.phone=q.session_id
        ORDER BY CASE d.status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END DESC,d.event_at DESC LIMIT 1) d ON true
      LEFT JOIN LATERAL (SELECT message->>'customer_name' AS name FROM public.chat_memory WHERE session_id=q.session_id AND COALESCE(message->>'customer_name','')<>'' ORDER BY id DESC LIMIT 1) n ON true
      WHERE q.payload ? 'dynamicTemplate' AND NOT(q.payload ? 'campaignRecipientId')
      ORDER BY q.created_at DESC LIMIT 50 OFFSET $1`,[offset])).rows.map(r=>enrich(r))};}
  async beforeDispatch(row){
    if(!row.payload?.campaignRecipientId)return;
    if(!uuid(row.payload.campaignRecipientId))throw fault('INVALID_CAMPAIGN_ENVELOPE',403);
    if(!this.enabled()||this.env.WHATSAPP_CAMPAIGNS_WORKER_ENABLED!=='true')throw fault('CAMPAIGN_SENDING_DISABLED');
    this.testRecipients([{phone:row.session_id}]);
    const r=(await this.pool.query(`SELECT r.phone,r.campaign_id,r.queue_request_id,r.values,c.owner_name,c.template,c.revision,p.status,p.categories FROM public.whatsapp_template_campaign_recipients r
      JOIN public.whatsapp_template_campaigns c ON c.id=r.campaign_id LEFT JOIN public.whatsapp_contact_permissions p ON p.phone=r.phone WHERE r.id=$1`,[row.payload.campaignRecipientId])).rows[0];
    const input=row.payload.dynamicTemplate,ordered=v=>Object.entries(v||{}).sort(([a],[b])=>a.localeCompare(b));
    if(!r||r.phone!==row.session_id||r.queue_request_id!==row.request_id||r.owner_name!==row.owner_name||r.template.id!==input?.templateId||r.template.language!==input.language||r.revision!==input.revision||hash(ordered(r.values))!==hash(ordered(input.values)))throw fault('INVALID_CAMPAIGN_ENVELOPE',403);
    await this.testCampaign(this.pool,r.campaign_id);
    const a=this.account(row.owner_name);if(a?.role!=='admin'||!await this.canAccess(a,r.phone))throw fault('SEND_PERMISSION_REVOKED',403);
    const reason=consentReason(r,r.template.category);if(reason)throw fault(reason,403);
  }
  async tick(){
    if(this.busy||!this.enabled()||this.env.WHATSAPP_CAMPAIGNS_WORKER_ENABLED!=='true'||!this.dynamic.enabled())return;
    this.busy=true;let c,locked=false;
    try{
      c=await this.pool.connect();
      locked=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('wa-campaign-scheduler-v1',0)) AS ok")).rows[0].ok;if(!locked)return;
      await this.ready();
      // The durable queue is the sole sender. One global campaign handoff in flight.
      await c.query(`UPDATE public.whatsapp_template_campaign_recipients r SET state=CASE WHEN q.state='cancelled' THEN 'excluded' ELSE q.state END,reason=q.reason,message_id=q.result->>'messageId',updated_at=now()
        FROM public.dashboard_send_queue q,public.whatsapp_template_campaigns c
        WHERE c.id=r.campaign_id AND q.owner_name=c.owner_name AND q.request_id=r.queue_request_id::text AND r.state='queued' AND q.state IN ('sent','failed','unknown','cancelled')`);
      await c.query("UPDATE public.whatsapp_template_campaigns c SET state='paused' WHERE state='running' AND EXISTS(SELECT 1 FROM public.whatsapp_template_campaign_recipients r WHERE r.campaign_id=c.id AND r.state='unknown')");
      await c.query("UPDATE public.whatsapp_template_campaigns c SET state='completed' WHERE state='running' AND NOT EXISTS(SELECT 1 FROM public.whatsapp_template_campaign_recipients r WHERE r.campaign_id=c.id AND r.state IN ('pending','queued','unknown'))");
      const inFlight=(await c.query("SELECT 1 FROM public.whatsapp_template_campaign_recipients WHERE state='queued' LIMIT 1")).rowCount;if(inFlight)return;
      const r=(await c.query(`SELECT r.*,c.owner_name,c.template,c.revision,c.interval_ms FROM public.whatsapp_template_campaign_recipients r
        JOIN public.whatsapp_template_campaigns c ON c.id=r.campaign_id WHERE c.state='running' AND c.next_at<=now() AND r.state='pending'
        ORDER BY c.created_at,r.phone LIMIT 1`)).rows[0];if(!r)return;
      await this.testCampaign(c,r.campaign_id);this.testRecipients([r]);
      const pacing=(await c.query(`SELECT q.created_at+greatest($1::int,c.interval_ms)*interval '1 millisecond'>now() AS wait
        FROM public.dashboard_send_queue q JOIN public.whatsapp_template_campaign_recipients r ON r.queue_request_id::text=q.request_id
        JOIN public.whatsapp_template_campaigns c ON c.id=r.campaign_id
        WHERE q.payload ? 'campaignRecipientId' ORDER BY q.created_at DESC LIMIT 1`,[r.interval_ms])).rows[0];if(pacing?.wait)return;
      const owner=this.account(r.owner_name),permission=(await this.permissions([r.phone])).get(r.phone);
      const reason=owner?.role!=='admin'||!await this.canAccess(owner,r.phone)?'SEND_PERMISSION_REVOKED':consentReason(permission,r.template.category);
      if(reason){await c.query("UPDATE public.whatsapp_template_campaign_recipients SET state='excluded',reason=$2,eligible=false WHERE id=$1",[r.id,reason]);return;}
      const blocked=(await c.query("SELECT 1 FROM public.dashboard_send_queue WHERE session_id=$1 AND state='unknown' AND resolution_at IS NULL LIMIT 1",[r.phone])).rowCount;
      if(blocked){await c.query("UPDATE public.whatsapp_template_campaign_recipients SET state='excluded',reason='CONVERSATION_QUEUE_BLOCKED',eligible=false WHERE id=$1",[r.id]);return;}
      // Stable operation key survives a crash between enqueue and recording jobId.
      const generation=await this.queueStore.generation(r.phone);
      const result=await this.queueStore.enqueue({sessionId:r.phone,owner:r.owner_name,requestId:r.queue_request_id,generation,
        items:[{kind:'text',payload:{dynamicTemplate:{templateId:r.template.id,language:r.template.language,revision:r.revision,values:r.values},agentName:owner.displayName||owner.username,campaignRecipientId:r.id}}]});
      await c.query("UPDATE public.whatsapp_template_campaign_recipients SET state='queued',queue_job_id=$2 WHERE id=$1",[r.id,result.jobId]);
      // Global pacing lives in PostgreSQL, not the lifetime of a browser/process.
      await c.query("UPDATE public.whatsapp_template_campaigns SET next_at=greatest(next_at,now()+($1::int*interval '1 millisecond')) WHERE state='running'",[r.interval_ms]);
    }finally{try{if(locked)await c.query("SELECT pg_advisory_unlock(hashtextextended('wa-campaign-scheduler-v1',0))");}finally{c?.release();this.busy=false;}}
  }
  start(){if(this.timer||!this.enabled()||this.env.WHATSAPP_CAMPAIGNS_WORKER_ENABLED!=='true')return;this.timer=setInterval(()=>this.tick().catch(()=>console.error('WhatsApp campaign scheduler unavailable; uncertain sends are never retried')),1000);this.timer.unref?.();}
  stop(){clearInterval(this.timer);this.timer=null;}
  async delivery(b){
    if(typeof b.messageId!=='string'||!b.messageId||b.messageId.length>300||!['sent','delivered','read','failed'].includes(b.status)||!/^\d{10}$/.test(String(b.timestamp)))throw fault('INVALID_DELIVERY_EVENT',422);
    const n=phone(b.phone);if(!this.env.WHATSAPP_PHONE_NUMBER_ID||b.phoneNumberId!==this.env.WHATSAPP_PHONE_NUMBER_ID)throw fault('WRONG_WHATSAPP_ACCOUNT',403);
    await this.pool.query('INSERT INTO public.whatsapp_template_delivery_events(message_id,phone,status,event_at,error_code) VALUES($1,$2,$3,to_timestamp($4),$5) ON CONFLICT DO NOTHING',[b.messageId,n,b.status,Number(b.timestamp),Number.isInteger(b.errorCode)?b.errorCode:null]);return {accepted:true};
  }
}
function registerCampaigns(app,{service,requireAuth,requireAdmin,multer,env=process.env}){
  const router=require('express').Router();
  router.use(requireAuth,requireAdmin,async(req,res,next)=>{try{await service.admin(req.user);if(!service.enabled())throw fault('CAMPAIGNS_DISABLED');await service.ready();res.set('Cache-Control','no-store');next();}catch(e){res.status(e.status||503).json({error:e.definitive?e.code:'CAMPAIGNS_NOT_INSTALLED'});}});
  const run=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){res.status(e.status||503).json({error:e.definitive?e.code:'CAMPAIGNS_UNAVAILABLE'});}};
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1,fields:0}}).single('file');
  router.post('/import',(req,res,next)=>upload(req,res,e=>e?res.status(422).json({error:'IMPORT_SIZE_OR_FORMAT_LIMIT'}):next()),run(req=>{if(!req.file)throw fault('FILE_REQUIRED',422);return parseFile(req.file.buffer,req.file.originalname);}));
  router.post('/resolve',run(req=>service.resolve(req.body.rows,req.body.country)));
  router.post('/recipient-directory',run(req=>directoryTools.directory(service.pool,req.body)));
  router.get('/label-recipients',run(req=>service.labels(String(req.query.labels||'').split(',').map(Number),req.query.q||'',Number(req.query.offset||0),Number(req.query.limit||100))));
  const conversations=new CampaignConversations(service);
  router.get('/conversation-groups',run(req=>conversations.groups(req.query.q||'',Number(req.query.offset||0))));
  router.get('/conversation-group/:id',run(req=>conversations.group(req.params.id)));
  router.get('/conversation-list',run(req=>conversations.list({campaign:req.query.campaign||'',filter:req.query.filter||'all',q:req.query.q||'',offset:Number(req.query.offset||0),limit:Number(req.query.limit||50)})));
  router.post('/permissions',run(req=>service.consent(req.user,req.body)));
  router.get('/',run(req=>service.list(Number(req.query.offset||0))));
  router.post('/',run(req=>service.prepare(req.user,req.body,req.headers['idempotency-key'])));
  router.get('/:id/export',async(req,res)=>{try{const d=await service.detail(req.params.id);res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition',`attachment; filename="campaign-${d.campaign.id}.xlsx"`);res.send(xlsxReport(d));}catch(e){res.status(e.status||503).json({error:e.definitive?e.code:'EXPORT_UNAVAILABLE'});}});
  router.get('/:id/recipients',run(req=>historyPage(service.pool,req.params.id,{q:req.query.q||'',status:req.query.status||'all',offset:Number(req.query.offset||0)})));
  router.post('/:id/review',run(req=>service.review(req.user,req.params.id,req.body.reviewToken,req.body.excludePhones||[])));
  router.get('/:id',run(req=>service.detail(req.params.id)));
  router.post('/:id/:action',run(req=>service.control(req.user,req.params.id,req.params.action,req.body.reviewToken)));
  app.use('/api/whatsapp/campaigns',router);
  app.post('/api/internal/whatsapp/template-status',async(req,res)=>{
    const expected=env.INTERNAL_API_TOKEN,got=req.headers['x-api-key'];
    if(!expected||typeof got!=='string'||Buffer.byteLength(got)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(got),Buffer.from(expected)))return res.status(401).json({error:'UNAUTHORIZED'});
    if(!service.enabled())return res.status(503).json({error:'CAMPAIGNS_DISABLED'});
    try{res.json(await service.delivery(req.body));}catch(e){res.status(e.status||503).json({error:e.definitive?e.code:'STATUS_UNAVAILABLE'});}
  });
}
module.exports={Campaigns,registerCampaigns,mergeRows,consentReason};
