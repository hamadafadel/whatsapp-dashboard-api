'use strict';
const {templateTools}=require('./whatsapp-template-payload');
const {templateRevision}=require('./whatsapp-template-catalog');
const {fault}=require('./send-queue');
function sendConfig(env){
  let url,base,catalog;
  try{url=new URL(env.N8N_WHATSAPP_TEMPLATE_SEND_URL);base=new URL(env.N8N_SEND_WEBHOOK_URL);catalog=new URL(env.N8N_WHATSAPP_TEMPLATE_CATALOG_URL);}catch{throw fault('DYNAMIC_TEMPLATE_NOT_CONFIGURED');}
  if(env.WHATSAPP_DYNAMIC_TEMPLATES_ENABLED!=='true'||url.protocol!=='https:'||url.origin!==base.origin||url.pathname===base.pathname||url.pathname===catalog.pathname||url.username||url.password||url.search||url.hash||!env.INTERNAL_API_TOKEN)throw fault('DYNAMIC_TEMPLATE_NOT_CONFIGURED');
  return url.href;
}
function createDynamicTemplates({catalog,env=process.env,fetchImpl=global.fetch}){
  const tools=templateTools();
  async function validate(input){
    tools.recipient(input.sessionId);sendConfig(env);
    if(typeof input.templateId!=='string'||typeof input.language!=='string'||typeof input.revision!=='string')throw fault('TEMPLATE_ID_LANGUAGE_REVISION_REQUIRED',422);
    const data=await catalog.list({fresh:true});
    const t=data.templates.find(t=>t.id===input.templateId&&t.language===input.language);
    if(!t||t.status!=='APPROVED')throw fault('TEMPLATE_NO_LONGER_APPROVED',422);
    if(templateRevision(t)!==input.revision)throw fault('TEMPLATE_CHANGED_REFRESH_REQUIRED',409);
    tools.compile(t,input.values);
    return t;
  }
  return {
    enabled(){try{sendConfig(env);return true;}catch{return false;}},
    validate,
    async dispatch(row){
      const input=row.payload.dynamicTemplate;
      const t=await validate({...input,sessionId:row.session_id});
      const body={contractVersion:1,requestId:row.id,attemptToken:row.attempt_token,sessionId:row.session_id,
        agentName:row.payload.agentName,definition:t,values:input.values};
      // No retry. Anything after this call can be an actual Meta send: unknown stays blocked.
      const r=await fetchImpl(sendConfig(env),{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
        headers:{'Content-Type':'application/json','x-api-key':env.INTERNAL_API_TOKEN},body:JSON.stringify(body)});
      let data;try{data=await r.json();}catch{throw Error('SEND_RESULT_UNKNOWN');}
      if(!r.ok||data.success!==true||typeof data.message_id!=='string'||!data.message_id)throw Error('SEND_RESULT_UNKNOWN');
      return {success:true,message_id:data.message_id};
    }
  };
}
function registerDynamicTemplates(app,{requireAuth,requireConversationAccess,service,accept}){
  app.post('/api/whatsapp/template-send',requireAuth,requireConversationAccess(),async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{
      const b=req.body||{};await service.validate(b);
      // Reuse the existing durable text-envelope transport; dispatch intercepts ONLY this marker.
      const dynamicTemplate={templateId:b.templateId,language:b.language,revision:b.revision,values:b.values||{}};
      return accept(req,res,[{kind:'text',payload:{dynamicTemplate,agentName:req.user.displayName||req.user.username}}],{sessionId:b.sessionId,dynamicTemplate});
    }catch(e){res.status(e.definitive?e.status||422:503).json({error:e.definitive?e.code:'TEMPLATE_VALIDATION_UNAVAILABLE'});}
  });
}
module.exports={createDynamicTemplates,registerDynamicTemplates,sendConfig};
