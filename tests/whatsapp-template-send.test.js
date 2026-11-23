'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),http=require('node:http'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const {templateTools}=require('../whatsapp-template-payload');
const {normalizeTemplate,templateRevision,createTemplateCatalog}=require('../whatsapp-template-catalog');
const {createDynamicTemplates,registerDynamicTemplates,sendConfig}=require('../whatsapp-template-send');
const {SendQueue}=require('../send-queue');
const tools=templateTools();
const raw=(components=[{type:'BODY',text:'أهلا {{2}} {{1}} {{1}}'}],extra={})=>({id:'123',name:'approved_test',language:'ar',status:'APPROVED',category:'UTILITY',components,...extra});
const t=()=>normalizeTemplate(raw());
const env={N8N_SEND_WEBHOOK_URL:'https://n8n.example.invalid/old-send',N8N_WHATSAPP_TEMPLATE_CATALOG_URL:'https://n8n.example.invalid/catalog',N8N_WHATSAPP_TEMPLATE_SEND_URL:'https://n8n.example.invalid/dynamic',INTERNAL_API_TOKEN:'SYNTHETIC',WHATSAPP_DYNAMIC_TEMPLATES_ENABLED:'true'};
const values={'components[0].text:1':'عربي 😀','components[0].text:2':'English'};
const input=()=>({sessionId:'201234567890',templateId:'123',language:'ar',revision:templateRevision(t()),values});
const service=(options={})=>createDynamicTemplates({env,catalog:{list:async()=>({templates:[t()]})},fetchImpl:async()=>{throw Error('NETWORK_FORBIDDEN');},...options});
test('positional parameters sorted numerically, duplicates removed, Arabic and emoji preserved',()=>{
 const c=tools.compile(t(),values);assert.deepEqual(c.components[0].parameters.map(v=>v.text),['عربي 😀','English']);
});
test('header/body named parameters remain separate; named button URLs use text suffix only',()=>{
 const a=normalizeTemplate(raw([{type:'HEADER',format:'TEXT',text:'{{name}}'},{type:'BODY',text:'{{name}}'},{type:'BUTTONS',buttons:[{type:'PHONE_NUMBER',phone_number:'+201111111111'},{type:'URL',url:'https://example.invalid/{{suffix}}'}]}],{parameter_format:'NAMED'}));
 const v={'components[0].text:name':'عنوان','components[1].text:name':'body','components[2].buttons[1].url:suffix':'123'};
 const c=tools.compile(a,v).components;assert.equal(c[0].parameters[0].parameter_name,'name');assert.equal(c[1].parameters[0].parameter_name,'name');
 assert.deepEqual(c[2],{type:'button',sub_type:'url',index:'1',parameters:[{type:'text',text:'123'}]});
});
for(const format of ['IMAGE','VIDEO','DOCUMENT'])for(const media of ['123456789','https://cdn.example.invalid/original.bin'])test(format+' header '+media,()=>{
 const a=normalizeTemplate(raw([{type:'HEADER',format},{type:'BODY',text:'static'}]));
 assert.equal(tools.compile(a,{'components[0].media':media}).components[0].parameters[0].type,format.toLowerCase());
});
test('location header validates coordinates',()=>{
 const a=normalizeTemplate(raw([{type:'HEADER',format:'LOCATION'}]));
 const v={'components[0].latitude':'30','components[0].longitude':'31','components[0].name':'القاهرة','components[0].address':'عنوان'};
 assert.equal(tools.compile(a,v).components[0].parameters[0].location.latitude,30);
 assert.throws(()=>tools.compile(a,{...v,'components[0].latitude':'91'}),/INVALID_LOCATION/);
});
test('FLOW, QUICK_REPLY and COPY_CODE compile exact indexes and permitted structures',()=>{
 const a=normalizeTemplate(raw([{type:'BODY',text:'ثابت'},{type:'BUTTONS',buttons:[{type:'QUICK_REPLY',text:'رد'},{type:'FLOW',text:'بيانات'},{type:'COPY_CODE',text:'نسخ'}]}]));
 const c=tools.compile(a,{'components[1].buttons[0].payload':'reply','components[1].buttons[1].flow_action_data':'{"order":1}','components[1].buttons[2].coupon_code':'SAVE'}).components;
 assert.deepEqual(c.map(x=>x.index),['0','1','2']);assert.equal(c[1].parameters[0].action.flow_token,'unused');assert.deepEqual(c[1].parameters[0].action.flow_action_data,{order:1});
});
for(const bad of [{},{...values,unexpected:'x'},{...values,'components[0].text:1':'\n'},{...values,'components[0].text:1':1}])test('invalid/missing parameter fails closed '+JSON.stringify(bad),()=>assert.throws(()=>tools.compile(t(),bad)));
for(const media of ['http://example.invalid/a','https://127.0.0.1/a','https://user:password@example.invalid/a','file:///a'])test('unsafe media rejected '+media,()=>assert.throws(()=>tools.compile(normalizeTemplate(raw([{type:'HEADER',format:'IMAGE'}])),{'components[0].media':media})));
for(const kind of ['CAROUSEL','LIMITED_TIME_OFFER','UNKNOWN'])test('advanced '+kind+' explicitly unavailable instead of malformed send',()=>{
 const a=normalizeTemplate(raw([{type:kind}]));assert.equal(tools.plan(a).supported,false);assert.throws(()=>tools.compile(a),/UNSUPPORTED/);
});
for(const sid of ['fb:123','ig:1:123','+201234567890','not-a-phone'])test('channel/recipient isolation '+sid,()=>assert.throws(()=>tools.recipient(sid)));
test('WhatsApp BSUID preserved',()=>assert.deepEqual(tools.recipient('EG.EXAMPLE_123'),{recipient_type:'individual',recipient:'EG.EXAMPLE_123'}));
test('static bodies and buttons require no fabricated components',()=>assert.deepEqual(tools.compile(normalizeTemplate(raw([{type:'BODY',text:'static'},{type:'BUTTONS',buttons:[{type:'URL',url:'https://example.invalid/'},{type:'QUICK_REPLY',text:'نعم'}]}])),{}),{name:'approved_test',language:{code:'ar'}}));
test('send gate disabled by default; send/catalog/legacy URLs cannot overlap',()=>{
 assert.throws(()=>sendConfig({...env,WHATSAPP_DYNAMIC_TEMPLATES_ENABLED:undefined}));
 for(const url of [env.N8N_SEND_WEBHOOK_URL,env.N8N_WHATSAPP_TEMPLATE_CATALOG_URL,'https://evil.invalid/a'])assert.throws(()=>sendConfig({...env,N8N_WHATSAPP_TEMPLATE_SEND_URL:url}));
});
test('admission and dispatch independently demand uncached APPROVED revision',async()=>{
 let reads=0,calls=0,approved=true;const s=service({catalog:{list:async options=>{assert.equal(options.fresh,true);reads++;return {templates:approved?[t()]:[]};}},fetchImpl:async()=>{calls++;return Response.json({success:true,message_id:'wamid.SYNTHETIC'});}});
 await s.validate(input());approved=false;await assert.rejects(s.dispatch({payload:{dynamicTemplate:input()},session_id:input().sessionId}),/NO_LONGER_APPROVED/);assert.equal(reads,2);assert.equal(calls,0);
});
test('language/revision mismatch rejects without send',async()=>{
 await assert.rejects(service().validate({...input(),language:'en'}),/NO_LONGER_APPROVED/);
 await assert.rejects(service().validate({...input(),revision:'old'}),/CHANGED/);
});
test('dispatch conveys claim identity only to dedicated n8n route and never retries',async()=>{
 const calls=[];const s=service({fetchImpl:async(url,options)=>{calls.push({url,options});throw Error('UNCERTAIN_SECRET');}});
 await assert.rejects(s.dispatch({id:'op',attempt_token:'claim',session_id:input().sessionId,payload:{dynamicTemplate:input(),agentName:'Agent'}}));
 assert.equal(calls.length,1);assert.equal(calls[0].url,env.N8N_WHATSAPP_TEMPLATE_SEND_URL);
 const b=JSON.parse(calls[0].options.body);assert.equal(b.requestId,'op');assert.equal(b.attemptToken,'claim');assert.equal(b.definition.id,'123');
 assert.equal(calls[0].options.redirect,'error');assert.ok(!JSON.stringify(b).includes('SYNTHETIC'));
});
test('existing queue treats uncertain template result as unknown and never resends it',async()=>{
 let claims=0,dispatch=0;const states=[];
 const q=new SendQueue({store:{lock:async()=>({claim:async()=>++claims===1?{id:'test'}:null,finish:async(r,s)=>states.push(s),release:async()=>{}})},dispatch:async()=>{dispatch++;throw Error('TIMEOUT');}});
 await q.run('201234567890');assert.equal(dispatch,1);assert.deepEqual(states,['unknown']);assert.equal(claims,1);
});
test('fresh catalog read bypasses cached approval',async()=>{
 let n=0;const c=createTemplateCatalog({env,fetchImpl:async()=>Response.json({ok:true,contractVersion:1,phoneAssociationVerified:true,records:n++===0?[raw()]:[]})});
 assert.equal((await c.list()).total,1);assert.equal((await c.list({fresh:true})).total,0);assert.equal(n,2);
});
test('authenticated local HTTP admission enqueues once with stable identity; roles and channels guarded',async()=>{
 const app=express();app.use(express.json());let jobs=0;const admitted=new Map();
 registerDynamicTemplates(app,{service:service(),requireAuth:(req,res,next)=>{if(!req.headers.authorization)return res.sendStatus(401);req.user={username:'synthetic-agent'};next();},requireConversationAccess:()=>((req,res,next)=>req.headers['x-access']==='yes'?next():res.sendStatus(403)),accept:async(req,res,items,identity)=>{
   const id=req.headers['idempotency-key'];if(!admitted.has(id)){admitted.set(id,{items,identity});jobs++;}res.status(202).json({durable:true,jobId:'job'});
 }});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const url=`http://127.0.0.1:${server.address().port}/api/whatsapp/template-send`,post=(body=input(),extra={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'synthetic','x-access':'yes','Idempotency-Key':'fixed-synthetic-request',...extra},body:JSON.stringify(body)});
   assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal((await post(input(),{'x-access':'no'})).status,403);
   for(const sessionId of ['fb:123','ig:1:123'])assert.equal((await post({...input(),sessionId})).status,422);
   assert.equal((await post()).status,202);assert.equal((await post()).status,202);assert.equal(jobs,1);
   assert.equal(admitted.values().next().value.items[0].kind,'text');assert.equal(admitted.values().next().value.items[0].payload.dynamicTemplate.templateId,'123');
 }finally{await new Promise(r=>server.close(r));}
});
test('legacy template handler is byte-for-byte unchanged from baseline',()=>{
 const current=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
 const original=execFileSync('git',['show','HEAD:server.js'],{cwd:require('node:path').join(__dirname,'..'),encoding:'utf8'});
 const section=s=>s.slice(s.indexOf("app.post('/api/send-template'"),s.indexOf('function buildOrderConfirmationPreview'));
 assert.equal(section(current),section(original));
});
