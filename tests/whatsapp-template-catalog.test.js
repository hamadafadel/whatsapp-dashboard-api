'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),express=require('express');
const {createTemplateCatalog,normalizeTemplate,configFromEnv,registerTemplateCatalog}=require('../whatsapp-template-catalog');
const env={N8N_SEND_WEBHOOK_URL:'https://n8n.example.invalid/webhook/send',N8N_WHATSAPP_TEMPLATE_CATALOG_URL:'https://n8n.example.invalid/webhook/catalog',INTERNAL_API_TOKEN:'synthetic-internal-key'};
const template=(extra={})=>({id:'100',name:'hello_2',language:'ar',category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'أهلا {{1}} 🌷\nطلب {{2}}'}],...extra});
const contract=records=>({ok:true,contractVersion:1,phoneAssociationVerified:true,records});
const response=body=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
test('configuration uses existing internal key, never a Meta token',()=>{
  assert.deepEqual(configFromEnv(env),{url:env.N8N_WHATSAPP_TEMPLATE_CATALOG_URL,secret:env.INTERNAL_API_TOKEN});
});
for(const extra of [{N8N_WHATSAPP_TEMPLATE_CATALOG_URL:undefined},{INTERNAL_API_TOKEN:''},
  {N8N_WHATSAPP_TEMPLATE_CATALOG_URL:env.N8N_SEND_WEBHOOK_URL},
  {N8N_WHATSAPP_TEMPLATE_CATALOG_URL:'https://evil.invalid/catalog'},
  {N8N_WHATSAPP_TEMPLATE_CATALOG_URL:'http://n8n.example.invalid/catalog'},
  {N8N_WHATSAPP_TEMPLATE_CATALOG_URL:'https://n8n.example.invalid/catalog?token=unsafe'}])
  test('unsafe/missing bridge configuration fails closed '+JSON.stringify(extra),()=>assert.throws(()=>configFromEnv({...env,...extra})));
test('Arabic multiline positional variables deduplicated per component',()=>{
  const t=normalizeTemplate(template({components:[{type:'HEADER',format:'TEXT',text:'{{1}}'},{type:'BODY',text:'{{1}}\n{{1}} {{2}}'}]}));
  assert.equal(t.variables.length,3);assert.notEqual(t.variables[0].key,t.variables[1].key);
});
test('named parameters and dynamic URL buttons retained without sample handles',()=>{
  const t=normalizeTemplate(template({parameter_format:'NAMED',components:[{type:'BODY',text:'{{customer_name}}'},{type:'BUTTONS',buttons:[{type:'URL',text:'عرض',url:'https://example.invalid/{{order}}',example:['secret-sample']}]}]}));
  assert.equal(t.parameterFormat,'NAMED');assert.deepEqual(t.variables.map(v=>v.name),['customer_name','order']);
  assert.ok(!JSON.stringify(t).includes('secret-sample'));
});
test('nonapproved templates are never displayed',()=>assert.equal(normalizeTemplate(template({status:'PAUSED'})),null));
test('media/advanced requirements visible but do not fetch media',()=>{
  const t=normalizeTemplate(template({components:[{type:'HEADER',format:'IMAGE'},{type:'CAROUSEL',cards:[{components:[{type:'BODY',text:'{{1}}'}]}]}]}));
  assert.equal(t.requirements[0].type,'IMAGE');assert.equal(t.variables.length,1);assert.ok(t.warnings.length);
});
test('fetch is GET to n8n only, never Graph or send webhook',async()=>{
  const calls=[];const c=createTemplateCatalog({env,fetchImpl:async(url,options)=>{calls.push({url,options});return response(contract([template()]));}});
  const result=await c.list();assert.equal(result.total,1);assert.equal(result.dynamicSendingEnabled,false);
  assert.equal(calls[0].url,env.N8N_WHATSAPP_TEMPLATE_CATALOG_URL);assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.headers['x-api-key'],env.INTERNAL_API_TOKEN);assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.equal(calls[0].options.body,undefined);assert.equal(calls[0].options.redirect,'error');
});
test('concurrent loads share one request and cached objects cannot be mutated',async()=>{
  let calls=0;const c=createTemplateCatalog({env,fetchImpl:async()=>{calls++;return response(contract([template()]));}});
  const [a,b]=await Promise.all([c.list(),c.list()]);a.templates[0].name='modified';
  assert.equal(b.templates[0].name,'hello_2');assert.equal((await c.list()).templates[0].name,'hello_2');assert.equal(calls,1);
});
test('expired cache reloads rather than returning outdated approval',async()=>{
  let now=0,calls=0;const c=createTemplateCatalog({env,now:()=>now,ttlMs:10,fetchImpl:async()=>{calls++;return response(contract(calls===1?[template()]:[]));}});
  assert.equal((await c.list()).total,1);now=11;assert.equal((await c.list()).total,0);assert.equal(calls,2);
});
test('templates natural sorted; intentional same-name languages retained',async()=>{
  const c=createTemplateCatalog({env,fetchImpl:async()=>response(contract([template({id:'1',name:'hello_10'}),template({id:'2'}),template({id:'3',language:'en_US'})]))});
  const t=(await c.list()).templates;assert.deepEqual(t.map(x=>x.id),['2','3','1']);
});
test('identical duplicate IDs collapse, conflicting duplicates fail',async()=>{
  const make=records=>createTemplateCatalog({env,fetchImpl:async()=>response(contract(records))});
  assert.equal((await make([template(),template()]).list()).total,1);
  await assert.rejects(make([template(),template({language:'en_US'})]).list(),/CONFLICTING/);
});
for(const bad of [{data:[]},{...contract([]),contractVersion:2},{...contract([]),phoneAssociationVerified:false}])
  test('unverified or incompatible n8n contract rejected '+JSON.stringify(bad),async()=>{
    await assert.rejects(createTemplateCatalog({env,fetchImpl:async()=>response(bad)}).list(),/INVALID_CONTRACT/);
  });
test('n8n payload extra secret fields never reach API response',async()=>{
  const c=createTemplateCatalog({env,fetchImpl:async()=>response({...contract([{...template(),access_token:'SYNTHETIC_SECRET'}]),access_token:'SYNTHETIC_SECRET'})});
  assert.ok(!JSON.stringify(await c.list()).includes('SYNTHETIC_SECRET'));
});
test('HTTP/network errors never disclose upstream responses or secrets',async()=>{
  for(const fetchImpl of [async()=>new Response('SYNTHETIC_SECRET',{status:403}),async()=>{throw Error('SYNTHETIC_SECRET');}])
    await assert.rejects(createTemplateCatalog({env,fetchImpl}).list(),e=>!e.message.includes('SYNTHETIC_SECRET'));
});
test('auth and role middleware protect catalog; no dynamic send route exists',async()=>{
  const app=express();let reads=0;
  const auth=(req,res,next)=>req.headers.authorization?next():res.sendStatus(401);
  const role=(req,res,next)=>req.headers['x-test-role']==='agent'?next():res.sendStatus(403);
  registerTemplateCatalog(app,{requireAuth:auth,requireConversationRole:role,catalog:{list:async()=>{reads++;return {templates:[]};}}});
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/whatsapp/template-catalog`;
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{headers:{Authorization:'synthetic'}})).status,403);
    const r=await fetch(url,{headers:{Authorization:'synthetic','x-test-role':'agent'}});
    assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(reads,1);
    assert.equal((await fetch(url,{method:'POST'})).status,404);assert.equal(reads,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
