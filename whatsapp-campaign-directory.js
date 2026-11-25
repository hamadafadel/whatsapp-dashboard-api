'use strict';
const {fault}=require('./send-queue');
// Read-only directory. Existing conversation/Label identities, never a parallel contact store.
async function directory(pool,{labels=[],all=false,q='',offset=0,limit=50,identitiesOnly=false,exclude=[]}={}){
 if(typeof all!=='boolean'||typeof identitiesOnly!=='boolean'||!Array.isArray(labels)||labels.length>100||labels.some(x=>!Number.isSafeInteger(x)||x<1)||(!all&&!labels.length)||typeof q!=='string'||q.length>120||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200||!Array.isArray(exclude)||exclude.length>10000||exclude.some(x=>typeof x!=='string'||!(/^[1-9]\d{6,14}$/).test(x)))throw fault('INVALID_DIRECTORY_QUERY',422);
 const cte=`WITH ids AS (SELECT session_id FROM public.chat_sessions WHERE session_id ~ '^[1-9][0-9]{6,14}$' UNION SELECT session_id FROM public.chat_memory WHERE session_id ~ '^[1-9][0-9]{6,14}$'), contacts AS (
 SELECT i.session_id AS phone,COALESCE(n.name,'') AS name,COALESCE(a.label_ids,'{}'::int[]) AS label_ids FROM ids i
 LEFT JOIN LATERAL (SELECT array_agg(label_id ORDER BY label_id) AS label_ids FROM public.conversation_label_assignments WHERE session_id=i.session_id) a ON true
 LEFT JOIN LATERAL (SELECT message->>'customer_name' AS name FROM public.chat_memory WHERE session_id=i.session_id AND COALESCE(message->>'customer_name','')<>'' ORDER BY id DESC LIMIT 1) n ON true
 WHERE ($1::boolean OR COALESCE(a.label_ids,'{}'::int[]) && $2::int[]) AND NOT(i.session_id=ANY($4::text[]))
 ), matches AS (SELECT * FROM contacts WHERE $3='' OR position(lower($3) IN lower(name))>0 OR position($7 IN phone)>0)`;
 const args=[all,[...new Set(labels)],q.trim(),exclude];
 // A single statement gives an exact count even on an empty/out-of-range page.
 const phoneSearch=/\d/.test(q)&&/^\+?[\d\s().-]+$/.test(q.trim())?q.replace(/\D/g,''):q.trim();
 const result=await pool.query(cte+` SELECT (SELECT count(*)::int FROM matches) AS total,COALESCE((SELECT jsonb_agg(x) FROM (SELECT ${identitiesOnly?'phone,label_ids':'phone,name,label_ids'} FROM matches ORDER BY phone LIMIT $5 OFFSET $6) x),'[]'::jsonb) AS rows`,[...args,identitiesOnly?10001:limit,identitiesOnly?0:offset,phoneSearch]);
 const data=result.rows[0];if(identitiesOnly&&data.total>10000)throw fault('RECIPIENT_LIMIT',422);
 if(identitiesOnly)return {rows:data.rows,total:data.total,identitiesOnly:true};
 const phones=data.rows.map(r=>r.phone),perms=await pool.query('SELECT phone,status,categories FROM public.whatsapp_contact_permissions WHERE phone=ANY($1::text[])',[phones]);
 return {rows:data.rows.map(r=>({...r,permission:perms.rows.find(p=>p.phone===r.phone)||null})),total:data.total,offset,limit};
}
async function names(pool,phones){if(!phones.length)return new Map();const r=await pool.query(`SELECT p.phone,n.name FROM unnest($1::text[]) p(phone) LEFT JOIN LATERAL (SELECT message->>'customer_name' AS name FROM public.chat_memory WHERE session_id=p.phone AND COALESCE(message->>'customer_name','')<>'' ORDER BY id DESC LIMIT 1) n ON true`,[phones]);return new Map(r.rows.map(x=>[x.phone,x.name||'']));}
module.exports={directory,names};
