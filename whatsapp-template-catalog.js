'use strict';
const {createHash} = require('node:crypto');
const {templateTools}=require('./whatsapp-template-payload');
function templateRevision(t){return createHash('sha256').update(JSON.stringify({id:t.id,name:t.name,language:t.language,parameterFormat:t.parameterFormat,components:t.components})).digest('hex');}
class CatalogError extends Error {
  constructor(code, status=503) { super(code); this.code=code; this.status=status; }
}
function configFromEnv(env) {
  let url,send;
  try {url=new URL(env.N8N_WHATSAPP_TEMPLATE_CATALOG_URL);send=new URL(env.N8N_SEND_WEBHOOK_URL);}
  catch {throw new CatalogError('WHATSAPP_CATALOG_NOT_CONFIGURED');}
  const secret=env.INTERNAL_API_TOKEN;
  if(url.protocol!=='https:' || url.origin!==send.origin || url.pathname===send.pathname ||
    url.username||url.password||url.search||url.hash||typeof secret!=='string'||!secret||/[\r\n]/.test(secret))
    throw new CatalogError('WHATSAPP_CATALOG_NOT_CONFIGURED');
  return {url:url.href,secret};
}
function sanitizeComponent(source, depth=0) {
  if(!source || typeof source!=='object' || Array.isArray(source) || depth>6) throw new CatalogError('META_INVALID_COMPONENT',502);
  const target={};
  for(const key of ['type','format','text','url','phone_number','title','button_type','example']) {
    // Deliberately omit examples: sample names/media handles are not needed for browsing.
    if(key==='example')continue;
    if(typeof source[key]==='string') {
      if(source[key].length>20000)throw new CatalogError('META_COMPONENT_TOO_LARGE',502);
      target[key]=source[key];
    }
  }
  for(const key of ['buttons','cards','components']) if(source[key]!==undefined) {
    if(!Array.isArray(source[key]) || source[key].length>100)throw new CatalogError('META_INVALID_COMPONENT',502);
    target[key]=source[key].map(item=>sanitizeComponent(item,depth+1));
  }
  return target;
}
function normalizeTemplate(source) {
  if(source?.status!=='APPROVED')return null;
  if(source.parameter_format&&!['POSITIONAL','NAMED'].includes(source.parameter_format))throw new CatalogError('META_INVALID_PARAMETER_FORMAT',502);
  if(!/^\d+$/.test(source.id||'') || !/^[a-z0-9_]{1,512}$/.test(source.name||'') ||
    !/^[a-zA-Z]{2,3}(?:_[a-zA-Z0-9]{2,8})?$/.test(source.language||'') || !Array.isArray(source.components))
    throw new CatalogError('META_INVALID_TEMPLATE',502);
  const components=source.components.map(item=>sanitizeComponent(item));
  // Keep only bounded HEADER sample URLs, separate from the canonical revision.
  // Meta upload handles are not message Media IDs. Never expose other examples.
  const mediaSamples={};
  source.components.forEach((c,i)=>{
    if(c.type==='HEADER'&&['IMAGE','VIDEO','DOCUMENT'].includes(c.format)){
      const samples=source.mediaSamples?.[i]||c.example?.header_handle;
      if(Array.isArray(samples))mediaSamples[i]=samples.filter(v=>typeof v==='string'&&v.length<=4096&&/^https:\/\//.test(v)).slice(0,3);
    }
  });
  const variables=[],requirements=[],warnings=[];
  function visit(component,path) {
    for(const field of ['text','url']) {
      const matches=String(component[field]||'').matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*|\d+)\s*\}\}/g);
      const seen=new Set();
      for(const match of matches) {
        if(seen.has(match[1]))continue;
        seen.add(match[1]);
        variables.push({key:`${path}.${field}:${match[1]}`,name:match[1],path,field,type:'text',componentType:component.type||'COMPONENT'});
      }
    }
    if(component.type==='HEADER' && component.format && component.format!=='TEXT')
      requirements.push({path,type:component.format});
    for(const key of ['buttons','cards','components']) (component[key]||[]).forEach((item,i)=>visit(item,`${path}.${key}[${i}]`));
  }
  components.forEach((item,i)=>visit(item,`components[${i}]`));
  if(components.some(c=>!['HEADER','BODY','FOOTER','BUTTONS'].includes(c.type)))warnings.push('ADVANCED_COMPONENT_PREVIEW');
  if(variables.length>100)throw new CatalogError('META_TOO_MANY_VARIABLES',502);
  return {id:source.id,name:source.name,language:source.language,status:'APPROVED',
    category:String(source.category||'UNKNOWN').slice(0,80),parameterFormat:source.parameter_format||'POSITIONAL',
    components,variables,requirements,warnings,...(Object.keys(mediaSamples).length?{mediaSamples}:{})};
}
function createTemplateCatalog({env=process.env,fetchImpl=global.fetch,now=()=>Date.now(),ttlMs=120000}={}) {
  let cache=null,pending=null;
  async function load(config,key) {
    let response;
    try {
      response=await fetchImpl(config.url,{method:'GET',headers:{'x-api-key':config.secret,Accept:'application/json'},
        redirect:'error',signal:AbortSignal.timeout(35000)});
    } catch { throw new CatalogError('N8N_CATALOG_UNAVAILABLE'); }
    if(!response.ok)throw new CatalogError('N8N_CATALOG_REQUEST_FAILED',502);
    let body;
    try {
      if(Number(response.headers?.get('content-length'))>2*1024*1024)throw Error();
      const text=await response.text();
      if(Buffer.byteLength(text)>2*1024*1024)throw Error();
      body=JSON.parse(text);
    }catch{throw new CatalogError('META_CATALOG_INVALID_RESPONSE',502);}
    if(body.ok!==true||body.contractVersion!==1||body.phoneAssociationVerified!==true||!Array.isArray(body.records)||body.records.length>10000)
      throw new CatalogError('N8N_CATALOG_INVALID_CONTRACT',502);
    const byId=new Map();
    for(const record of body.records) {
      const item=normalizeTemplate(record);if(!item)continue;
      if(byId.has(item.id)&&JSON.stringify(byId.get(item.id))!==JSON.stringify(item))throw new CatalogError('META_CONFLICTING_TEMPLATE',502);
      byId.set(item.id,item);
    }
    const collator=new Intl.Collator(['ar','en'],{numeric:true,sensitivity:'base'});
    const templates=[...byId.values()].sort((a,b)=>collator.compare(a.name,b.name)||collator.compare(a.language,b.language)||a.id.localeCompare(b.id));
    const result={source:'n8n-meta',templates,total:templates.length,fetchedAt:new Date(now()).toISOString(),
      dynamicSendingEnabled:false,phoneAssociationVerified:true};
    cache={key,expires:now()+ttlMs,result};return result;
  }
  return {
    async list({fresh=false}={}) {
      const config=configFromEnv(env);
      const key=createHash('sha256').update(JSON.stringify(config)).digest('hex');
      // Send validation must never join a possibly older in-flight browse request.
      if(fresh)return structuredClone(await load(config,key));
      if(cache?.key===key&&now()<cache.expires)return structuredClone(cache.result);
      if(!pending||pending.key!==key) {
        const task={key};task.promise=load(config,key).finally(()=>{if(pending===task)pending=null;});pending=task;
      }
      return structuredClone(await pending.promise);
    }
  };
}
function registerTemplateCatalog(app,{requireAuth,requireConversationRole,catalog=createTemplateCatalog(),dynamicEnabled=()=>false}={}) {
  app.get('/api/whatsapp/template-catalog',requireAuth,requireConversationRole,async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
      const data=await catalog.list();
      data.templates=data.templates.map(t=>{const {mediaSamples,...publicTemplate}=t;return {...publicTemplate,revision:templateRevision(t),sendSchema:templateTools().plan(t)};});
      data.dynamicSendingEnabled=dynamicEnabled();res.json(data);
    }
    catch(error) {
      const safe=error instanceof CatalogError?error:new CatalogError('META_CATALOG_UNAVAILABLE');
      res.status(safe.status).json({error:safe.code,message:'تعذر تحميل كتالوج Meta. الإرسال السريع الحالي لم يتغير.'});
    }
  });
}
module.exports={CatalogError,configFromEnv,normalizeTemplate,sanitizeComponent,templateRevision,createTemplateCatalog,registerTemplateCatalog};
