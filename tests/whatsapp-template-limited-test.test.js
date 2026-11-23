'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),http=require('node:http');
const {normalizeTemplate,templateRevision}=require('../whatsapp-template-catalog');
const {createDynamicTemplates,registerDynamicTemplates,sendConfig,testValuesHash}=require('../whatsapp-template-send');
const template=normalizeTemplate({id:'123456789',name:'synthetic',language:'ar',category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'مرحبا {{1}}'}]});
const values={'components[0].text:1':'اختبار فقط 😀'};
const input=()=>({sessionId:process.env.TEMPLATE_TEST_APPROVED_RECIPIENT||'201000000001',templateId:template.id,language:'ar',revision:templateRevision(template),values});
const context={owner:'synthetic-tester',requestId:'single-approved-test-request-01'};
const env={WHATSAPP_DYNAMIC_TEMPLATES_ENABLED:'true',WHATSAPP_DYNAMIC_TEMPLATES_TEST_MODE:'true',
 N8N_SEND_WEBHOOK_URL:'https://n8n.example.invalid/legacy',N8N_WHATSAPP_TEMPLATE_CATALOG_URL:'https://n8n.example.invalid/catalog',N8N_WHATSAPP_TEMPLATE_SEND_URL:'https://n8n.example.invalid/dynamic',INTERNAL_API_TOKEN:'SYNTHETIC',
 WHATSAPP_TEMPLATE_TEST_RECIPIENT:input().sessionId,WHATSAPP_TEMPLATE_TEST_USERNAME:context.owner,
 WHATSAPP_TEMPLATE_TEST_REQUEST_ID:context.requestId,WHATSAPP_TEMPLATE_TEST_TEMPLATE_ID:template.id,
 WHATSAPP_TEMPLATE_TEST_LANGUAGE:'ar',WHATSAPP_TEMPLATE_TEST_REVISION:templateRevision(template),WHATSAPP_TEMPLATE_TEST_VALUES_SHA256:testValuesHash(values)};
function setup(extra={}){let reads=0,posts=0;const config={...env,...extra};const service=createDynamicTemplates({env:config,catalog:{list:async()=>{reads++;return {templates:[template]};}},fetchImpl:async()=>{posts++;return Response.json({success:true,message_id:'wamid.SYNTHETIC'});}});return {config,service,counts:()=>({reads,posts})};}

test('test mode without explicit enable never reads catalog or sends',async()=>{const s=setup({WHATSAPP_DYNAMIC_TEMPLATES_ENABLED:'false'});assert.equal(s.service.enabled(),false);await assert.rejects(s.service.validate(input(),context));assert.deepEqual(s.counts(),{reads:0,posts:0});});
for(const key of Object.keys(env).filter(k=>k.startsWith('WHATSAPP_TEMPLATE_TEST_')))test('missing test constraint fails closed: '+key,()=>{const s=setup({[key]:undefined});assert.equal(s.service.enabled(),false);assert.throws(()=>sendConfig(s.config),/TEST_NOT_CONFIGURED/);});
test('unrecognized test mode never silently opens unrestricted access',()=>{assert.equal(setup({WHATSAPP_DYNAMIC_TEMPLATES_TEST_MODE:'TRUE'}).service.enabled(),false);});
test('missing mode cannot accidentally enable unrestricted sending',()=>{const s=setup({WHATSAPP_DYNAMIC_TEMPLATES_TEST_MODE:undefined});assert.equal(s.service.enabled(),false);assert.throws(()=>sendConfig(s.config),/TEST_NOT_CONFIGURED/);});
test('valid restricted test keeps public catalog UI in preview-only mode',async()=>{const s=setup();assert.equal(s.service.enabled(),false);await s.service.validate(input(),context);assert.equal(s.counts().posts,0);});
for(const [name,change,who] of [
 ['different customer',{sessionId:'201000000002'},context],['different template',{templateId:'OTHER'},context],
 ['different language',{language:'en'},context],['changed revision',{revision:'OTHER'},context],
 ['changed values',{values:{'components[0].text:1':'changed'}},context],
 ['different account',{}, {...context,owner:'another-user'}],['different request ID',{}, {...context,requestId:'another-request-id'}],
 ['missing trusted context',{},undefined]
])test(name+' rejected before catalog/network',async()=>{const s=setup();await assert.rejects(s.service.validate({...input(),...change},who),/TEST_NOT_AUTHORIZED/);assert.deepEqual(s.counts(),{reads:0,posts:0});});
test('fixed approved envelope validates then dispatches only the claimed row',async()=>{const s=setup();await s.service.validate(input(),context);await s.service.dispatch({id:'synthetic-row',attempt_token:'synthetic-claim',session_id:input().sessionId,owner_name:context.owner,request_id:context.requestId,payload:{dynamicTemplate:input()}});assert.deepEqual(s.counts(),{reads:2,posts:1});});
test('dispatch checks durable owner/request/recipient again, including old queued rows',async()=>{for(const change of [{owner_name:'other'},{request_id:'other-request'},{session_id:'201000000002'}]){const s=setup();await assert.rejects(s.service.dispatch({id:'synthetic-row',attempt_token:'claim',session_id:input().sessionId,owner_name:context.owner,request_id:context.requestId,payload:{dynamicTemplate:input()},...change}),/TEST_NOT_AUTHORIZED/);assert.deepEqual(s.counts(),{reads:0,posts:0});}});
test('turning flag off between admission and dispatch blocks network',async()=>{const s=setup();await s.service.validate(input(),context);s.config.WHATSAPP_DYNAMIC_TEMPLATES_ENABLED='false';await assert.rejects(s.service.dispatch({session_id:input().sessionId,owner_name:context.owner,request_id:context.requestId,payload:{dynamicTemplate:input()}}));assert.equal(s.counts().posts,0);});
test('hash is order independent but distinguishes exact approved text',()=>{assert.equal(testValuesHash({b:'2',a:'1'}),testValuesHash({a:'1',b:'2'}));assert.notEqual(testValuesHash({a:'1'}),testValuesHash({a:'١'}));});
test('local HTTP uses JWT identity/header rather than supplied user; fixed request replays one durable admission',async()=>{
 const s=setup(),app=express();app.use(express.json());let jobs=0;const admitted=new Map();
 registerDynamicTemplates(app,{service:s.service,requireAuth:(req,res,next)=>{req.user={username:req.headers['x-synthetic-user']||context.owner};next();},requireConversationAccess:()=>((req,res,next)=>next()),accept:async(req,res,items,identity)=>{
  const key=req.user.username+':'+req.headers['idempotency-key'];const serialized=JSON.stringify(identity);
  if(admitted.has(key)&&admitted.get(key)!==serialized)return res.status(409).json({error:'IDEMPOTENCY_CONFLICT'});
  if(!admitted.has(key)){admitted.set(key,serialized);jobs++;}res.status(202).json({durable:true,jobId:'synthetic-job'});
 }});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url=`http://127.0.0.1:${server.address().port}/api/whatsapp/template-send`,post=(body=input(),headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':context.requestId,...headers},body:JSON.stringify(body)});
  assert.equal((await post({...input(),sessionId:'201000000002'})).status,403);
  assert.equal((await post({...input(),username:context.owner},{'x-synthetic-user':'other'})).status,403);
  assert.equal((await post(input(),{'Idempotency-Key':'another-idempotency-key'})).status,403);
  const replies=await Promise.all([post(),post(),post()]);assert.deepEqual(replies.map(r=>r.status),[202,202,202]);assert.equal(jobs,1);assert.equal(s.counts().posts,0);
 }finally{await new Promise(r=>server.close(r));}
});
