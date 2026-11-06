'use strict';
// Worker-only adapter for the existing Dashboard account and visibility contract.
// Regression tests compare these decisions with the actual server.js functions.
function createWorkerAccess({pool,env=process.env}){
 function findAccount(username){
  const accounts=[{username:env.DASHBOARD_USERNAME||'admin',role:'admin'}];
  for(const [prefix,role] of [['DASHBOARD_AGENT1','agent'],['DASHBOARD_CONFIRMATION','confirmation'],['DASHBOARD_GALLERY','gallery']]){
   if(env[prefix+'_USERNAME']&&env[prefix+'_PASSWORD'])accounts.push({username:env[prefix+'_USERNAME'],role});
  }
  return accounts.find(a=>a.username===String(username||''))||null;
 }
 async function getAccess(sessionId){
  const result=await pool.query(`SELECT
   EXISTS(SELECT 1 FROM public.chat_sessions WHERE session_id=$1 AND COALESCE(hidden,false)=true) AS globally_hidden,
   EXISTS(SELECT 1 FROM public.chat_memory WHERE session_id=$1 AND message->>'message_kind'='template'
    AND message->>'template_name'='order_confirmation') AS is_confirmation,
   COALESCE((SELECT array_agg(username) FROM public.conversation_user_visibility
    WHERE session_id=$1 AND is_hidden=true),ARRAY[]::text[]) AS hidden_for_usernames`,[sessionId]);
  const row=result.rows[0]||{};
  return {globallyHidden:Boolean(row.globally_hidden),isConfirmation:Boolean(row.is_confirmation),hiddenForUsernames:new Set(row.hidden_for_usernames||[])};
 }
 function canAccess(user,state){
  if(!user||!state)return false;
  if(user.role==='admin')return true;
  if(!['agent','confirmation'].includes(user.role))return false;
  if(state.globallyHidden||state.hiddenForUsernames.has(user.username))return false;
  if(user.role==='confirmation'&&!state.isConfirmation)return false;
  return true;
 }
 return {findAccount,getAccess,canAccess};
}
module.exports={createWorkerAccess};
