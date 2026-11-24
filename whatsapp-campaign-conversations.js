'use strict';
const {fault}=require('./send-queue');
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
// A campaign receipt is joined to its canonical message, never to text or a guessed phone.
const incomingTime=`CASE WHEN COALESCE(u.message->'whatsapp_message'->>'timestamp','') ~ '^[0-9]{10}$'
 THEN to_timestamp((u.message->'whatsapp_message'->>'timestamp')::bigint)
 WHEN pg_input_is_valid(COALESCE(u.message->>'timestamp',''),'timestamp with time zone')
 THEN (u.message->>'timestamp')::timestamptz ELSE u.created_at END`;
const base=`WITH sent AS (
 SELECT r.id AS recipient_id,r.campaign_id,r.phone,r.name,c.title,c.created_at AS campaign_date,
        m.id AS sent_id,m.created_at AS sent_at,m.message->>'wa_message_id' AS sent_mid
 FROM public.whatsapp_template_campaign_recipients r
 JOIN public.whatsapp_template_campaigns c ON c.id=r.campaign_id
 JOIN public.chat_memory m ON m.session_id=r.phone AND m.message->>'campaign_recipient_id'=r.id::text
 WHERE m.message->>'type'='agent' AND m.message->>'campaign_id'=c.id::text AND ($1='' OR c.id::text=$1)
), evidence AS (
 SELECT s.*,e.reply_id,e.ambiguous_id,e.explicit_reply,
  EXISTS(SELECT 1 FROM public.chat_memory u LEFT JOIN public.chat_sessions cs ON cs.session_id=u.session_id
    WHERE u.session_id=s.phone AND u.message->>'type'='user' AND u.id>s.sent_id
    AND u.id>COALESCE(cs.last_read_message_id,0)) AS unread
 FROM sent s LEFT JOIN LATERAL (
  SELECT min(u.id) FILTER(WHERE ctx.mid=s.sent_mid OR(ctx.mid IS NULL AND candidates.n=1)) AS reply_id,
   min(u.id) FILTER(WHERE ctx.mid IS NULL AND candidates.n>1) AS ambiguous_id,
   bool_or(ctx.mid=s.sent_mid) AS explicit_reply
  FROM public.chat_memory u
  CROSS JOIN LATERAL(SELECT COALESCE(NULLIF(u.message->'reply_to'->>'external_message_id',''),
   NULLIF(u.message->'reply_to'->>'wa_message_id',''),NULLIF(u.message->'whatsapp_message'->'context'->>'id',''),
   NULLIF(u.message->'context'->>'id','')) AS mid) ctx
  CROSS JOIN LATERAL(SELECT count(*) AS n FROM (SELECT DISTINCT p.message->>'campaign_id' FROM public.chat_memory p
    WHERE p.session_id=u.session_id AND p.id<u.id AND p.message->>'campaign_recipient_id' IS NOT NULL
    LIMIT 2) possible) candidates
  WHERE u.session_id=s.phone AND u.message->>'type'='user' AND u.id>s.sent_id
   AND COALESCE(u.message->>'source','')<>'history_sync'
   AND (${incomingTime})>=date_trunc('second',s.sent_at)
 ) e ON true
), matched AS (
 SELECT e.*,CASE WHEN reply_id IS NOT NULL THEN CASE WHEN explicit_reply THEN 'explicit' ELSE 'after_send' END
   WHEN ambiguous_id IS NOT NULL THEN 'ambiguous' ELSE 'not_replied' END AS response,
  latest.id,latest.message->>'content' AS content,latest.message->>'message_kind' AS message_kind,
  latest.message->>'type' AS type,COALESCE(n.customer_name,e.name) AS customer_name,
  (SELECT count(*)::int FROM public.chat_memory u WHERE u.session_id=e.phone AND u.message->>'type'='user'
    AND u.id>COALESCE(cs.last_read_message_id,0)) AS unread_count
 FROM evidence e
 JOIN LATERAL(SELECT id,message FROM public.chat_memory WHERE session_id=e.phone ORDER BY id DESC LIMIT 1) latest ON true
 LEFT JOIN public.chat_sessions cs ON cs.session_id=e.phone
 LEFT JOIN LATERAL(SELECT message->>'customer_name' AS customer_name FROM public.chat_memory
   WHERE session_id=e.phone AND COALESCE(message->>'customer_name','')<>'' ORDER BY id DESC LIMIT 1) n ON true
 WHERE COALESCE(cs.hidden,false)=false
)`;
class CampaignConversations{
 constructor(service){this.service=service;this.pool=service.pool;}
 async list({campaign='',filter='all',q='',offset=0,limit=50}={}){
  if(campaign&&!uuid(campaign))throw fault('INVALID_CAMPAIGN_ID',422);
  campaign=campaign.toLowerCase();
  if(!['all','replied','not_replied','unread','ambiguous'].includes(filter)||typeof q!=='string'||q.length>120||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw fault('INVALID_PAGE_OR_FILTER',422);
  const selection=`SELECT DISTINCT ON(phone) *,phone AS session_id,'whatsapp'::text AS channel
   FROM matched WHERE ($1='' OR campaign_id::text=$1) AND
    ($2='all' OR($2='replied' AND response IN ('explicit','after_send')) OR($2='not_replied' AND response='not_replied') OR($2='ambiguous' AND response='ambiguous') OR($2='unread' AND unread))
    AND($3='' OR position(lower($3) IN lower(customer_name))>0 OR position($3 IN phone)>0)
   ORDER BY phone,sent_id DESC`;
  const r=await this.pool.query(base+`, chosen AS (${selection}) SELECT (SELECT count(*)::int FROM chosen) AS total,
   COALESCE((SELECT jsonb_agg(x ORDER BY x.id DESC,x.session_id) FROM (SELECT * FROM chosen ORDER BY id DESC,session_id LIMIT $4 OFFSET $5)x),'[]'::jsonb) AS rows`,[campaign,filter,q.trim(),limit,offset]);
  return {...r.rows[0],offset,limit};
 }
 async groups(q='',offset=0){
  if(typeof q!=='string'||q.length>120||!Number.isSafeInteger(offset)||offset<0)throw fault('INVALID_PAGE',422);
  const r=await this.pool.query(`WITH selected AS(SELECT id,title,created_at,count(*) OVER()::int AS total FROM public.whatsapp_template_campaigns
   WHERE $1='' OR position(lower($1) IN lower(title))>0 ORDER BY created_at DESC,id LIMIT 50 OFFSET $2)
   SELECT c.*,(SELECT count(*)::int FROM public.whatsapp_template_campaign_recipients r WHERE r.campaign_id=c.id) AS recipients
   FROM selected c ORDER BY c.created_at DESC,c.id`,[q,offset]);
  return {rows:r.rows,total:r.rows[0]?.total||0,offset,limit:50};
 }
 async group(id){if(!uuid(id))throw fault('INVALID_CAMPAIGN_ID',422);const r=await this.pool.query('SELECT c.id,c.title,c.created_at,count(r.id)::int AS recipients FROM public.whatsapp_template_campaigns c LEFT JOIN public.whatsapp_template_campaign_recipients r ON r.campaign_id=c.id WHERE c.id=$1 GROUP BY c.id',[id]);if(!r.rows.length)throw fault('CAMPAIGN_NOT_FOUND',404);return r.rows[0];}
}
module.exports={CampaignConversations,base};
