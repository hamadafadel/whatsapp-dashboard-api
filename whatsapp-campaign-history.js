'use strict';
const {fault}=require('./send-queue'),{enrich}=require('./whatsapp-campaign-report');
async function historyPage(pool,id,{q='',status='all',offset=0,limit=50}={}){
 if(!/^[a-f0-9-]{36}$/i.test(id)||typeof q!=='string'||q.length>120||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||!['all','pending','queued','sending','sent','delivered','read','failed','unknown','excluded'].includes(status))throw fault('INVALID_HISTORY_PAGE',422);
 const campaign=(await pool.query('SELECT * FROM public.whatsapp_template_campaigns WHERE id=$1',[id])).rows[0];if(!campaign)throw fault('CAMPAIGN_NOT_FOUND',404);
 const r=await pool.query(`WITH records AS(
  SELECT r.*,q.state AS queue_state,q.reason AS queue_reason,q.updated_at AS queue_updated_at,q.result->>'messageId' AS confirmed_mid,
   d.status AS delivery_status,d.event_at AS delivery_at,d.error_code AS delivery_error_code,
   COALESCE(d.status,CASE WHEN COALESCE(q.state,r.state)='cancelled' OR($3='cancelled' AND COALESCE(q.state,r.state)='pending') THEN 'excluded' ELSE COALESCE(q.state,r.state) END) AS final_status
  FROM public.whatsapp_template_campaign_recipients r LEFT JOIN public.dashboard_send_queue q ON q.owner_name=$2 AND q.request_id=r.queue_request_id::text
  LEFT JOIN LATERAL(SELECT d.status,d.event_at,d.error_code FROM public.whatsapp_template_delivery_events d WHERE d.message_id=COALESCE(q.result->>'messageId',r.message_id) AND d.phone=r.phone
   ORDER BY CASE d.status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END DESC,d.event_at DESC LIMIT 1)d ON true
  WHERE r.campaign_id=$1
 ),matches AS(SELECT * FROM records WHERE ($4='' OR position(lower($4) IN lower(name))>0 OR position($4 IN phone)>0)
  AND($5='all' OR final_status=$5 OR($5='sent' AND final_status IN ('delivered','read')) OR($5='delivered' AND final_status='read'))),
 totals AS(SELECT count(*)::int AS total,count(*) FILTER(WHERE final_status IN ('sent','delivered','read'))::int AS sent,
  count(*) FILTER(WHERE final_status IN ('pending','queued','sending'))::int AS remaining,count(*) FILTER(WHERE final_status='excluded')::int AS excluded,
  count(*) FILTER(WHERE final_status='failed')::int AS failed,count(*) FILTER(WHERE final_status='unknown')::int AS unknown,
  count(*) FILTER(WHERE final_status IN ('delivered','read'))::int AS delivered,count(*) FILTER(WHERE final_status='read')::int AS read FROM records)
 SELECT row_to_json(totals) AS summary,(SELECT count(*)::int FROM matches) AS matching,
  COALESCE((SELECT jsonb_agg(x) FROM(SELECT m.*,EXISTS(SELECT 1 FROM public.chat_memory cm WHERE cm.session_id=m.phone) AS conversation_available FROM matches m ORDER BY phone LIMIT $6 OFFSET $7)x),'[]'::jsonb) AS recipients FROM totals`,[id,campaign.owner_name,campaign.state,q.trim(),status,limit,offset]);
 const {summary,matching,recipients}=r.rows[0];summary.processed=summary.total-summary.remaining;summary.progress=summary.total?Math.round(summary.processed*100/summary.total):0;
 return {campaign,summary,recipients:recipients.map(x=>enrich(x,campaign)),pagination:{total:matching,offset,limit,hasMore:offset+limit<matching}};
}
module.exports={historyPage};
