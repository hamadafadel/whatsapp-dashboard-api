'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {inspect,sampleUrl,publicV4,downloadSample,TemplateMedia,registerTemplateMedia,LIMITS}=require('../whatsapp-template-media');
const {normalizeTemplate,templateRevision}=require('../whatsapp-template-catalog');
const {templateTools}=require('../whatsapp-template-payload');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
const raw={id:'123',name:'media_template',language:'ar',status:'APPROVED',components:[{type:'HEADER',format:'IMAGE',example:{header_handle:['https://scontent.xx.fbcdn.net/sample?expires=1','4:opaque-handle'],access_token:'SECRET'}},{type:'BODY',text:'Hello'}]};
const t=normalizeTemplate(raw),revision=templateRevision(t),catalog={list:async()=>({templates:[t]})};
test('sample URL separate from canonical revision; handles, text examples and secrets are not media IDs',()=>{
 assert.deepEqual(t.mediaSamples,{0:['https://scontent.xx.fbcdn.net/sample?expires=1']});assert(!JSON.stringify(t).includes('SECRET'));
 const next=normalizeTemplate({...raw,components:[{...raw.components[0],example:{header_handle:['https://other.fbcdn.net/new']}},raw.components[1]]});
 assert.equal(templateRevision(next),revision);assert.equal(templateTools().compile(t,{'components[0].media':'https://api.example.test/uploads/template-headers/immutable'}).components[0].parameters[0].image.link,'https://api.example.test/uploads/template-headers/immutable');
});
test('content signature, format and size validated rather than client filename or MIME',()=>{
 assert.equal(inspect(png,'IMAGE').mime,'image/png');assert.equal(inspect(Buffer.from('%PDF-1.7\nsynthetic'),'DOCUMENT').mime,'application/pdf');
 assert.equal(inspect(Buffer.from([0,0,0,24,...Buffer.from('ftypisom')]),'VIDEO').mime,'video/mp4');
 for(const [b,f] of [[png,'VIDEO'],[Buffer.from('<script>'),'IMAGE'],[Buffer.alloc(0),'IMAGE'],[Buffer.alloc(LIMITS.IMAGE+1),'IMAGE']])assert.throws(()=>inspect(b,f));
});
test('sample download rejects non-CDN, credentials, HTTP, handles, redirects destinations and private DNS',async()=>{
 for(const url of ['http://s.fbcdn.net/a','https://evil.example/a','https://fbcdn.net.evil.example/a','https://user:secret@s.fbcdn.net/a','https://s.fbcdn.net:444/a','4:handle'])assert.equal(sampleUrl(url),null);
 for(const ip of ['127.0.0.1','10.0.1.2','172.16.2.3','192.168.1.2','169.254.169.254','100.64.1.1','0.0.0.0','::1'])assert.equal(publicV4(ip),false);
 assert(publicV4('157.240.1.1'));let requests=0;
 await assert.rejects(downloadSample('https://s.fbcdn.net/a',100,{resolve:async()=>['127.0.0.1'],request:()=>{requests++;}}));assert.equal(requests,0);
});
test('sample GET is pinned, bounded, has no auth, never follows redirects or calls messages endpoint',async()=>{
 for(const status of [200,302]){
 let calls=0;
 const result=downloadSample('https://s.fbcdn.net/image',1000,{resolve:async()=>['157.240.1.1'],request:(url,opts,callback)=>{
  calls++;assert.equal(url.pathname,'/image');assert.equal(opts.headers.Authorization,undefined);opts.lookup(url.hostname,{},(e,ip)=>assert.equal(ip,'157.240.1.1'));
  const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>req.emit('error',Error());
  queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.headers={};res.destroy=()=>{};callback(res);if(status===200){res.emit('data',png);res.emit('end');}});return req;
 }});
 if(status===200)assert.deepEqual(await result,png);else await assert.rejects(result);assert.equal(calls,1);
 }
});
test('expired/unavailable sample falls back without persisting or sending; requires current approval/revision',async()=>{
 let writes=0;const s=new TemplateMedia({catalog,pool:{connect:async()=>{writes++;}},download:async()=>{throw Error('expired');}});
 await assert.rejects(s.importSample('123','ar',revision,'admin'));assert.equal(writes,0);
 await assert.rejects(s.save('123','ar','old',png,'admin'),/REVISION_REQUIRED/);
 await assert.rejects(s.save('123','ar','0'.repeat(64),png,'admin'),/CHANGED/);
 await assert.rejects(s.get('123','en_US'),/NO_LONGER_APPROVED/);
});
test('upload is atomic and rolls back if default association fails; sanitized errors only',async()=>{
 const calls=[];const client={query:async(sql)=>{calls.push(sql);if(sql.includes('INSERT INTO public.whatsapp_template_media_defaults'))throw Error('synthetic private detail');},release:()=>calls.push('release')};
 const s=new TemplateMedia({catalog,pool:{connect:async()=>client}});await assert.rejects(s.save('123','ar',revision,png,'admin'));
 assert(calls.includes('ROLLBACK'));assert(!calls.includes('COMMIT'));assert.equal(calls.at(-1),'release');
});
test('HTTP endpoints authenticate reads and restrict shared-default writes before parsing multipart',async()=>{
 const express=require('express'),http=require('node:http'),multer=require('multer'),app=express();app.use(express.json());let writes=0;
 const auth=(req,res,next)=>req.headers.authorization?(req.user={username:'test',role:req.headers.authorization},next()):res.sendStatus(401);
 const role=(req,res,next)=>['admin','agent'].includes(req.user.role)?next():res.sendStatus(403);
 registerTemplateMedia(app,{service:{get:async()=>({media:null}),save:async()=>{writes++;return{};},pool:{query:async()=>({rows:[]})}},requireAuth:auth,requireConversationRole:role,requireAdmin:(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403),multer});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{for(const [method,authorization,status] of [['GET',null,401],['GET','gallery',403],['GET','agent',200],['POST','agent',403]]){const r=await fetch(base+'/api/whatsapp/template-media/123/ar',{method,headers:authorization?{authorization}:{}});assert.equal(r.status,status);}assert.equal(writes,0);
 assert.equal((await fetch(base+'/uploads/template-headers/not-an-id')).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('real multipart parser preserves bytes, emits an immutable public link and supports video/PDF byte ranges without sending',async()=>{
 const express=require('express'),http=require('node:http'),multer=require('multer'),app=express();app.use(express.json());const files=new Map();let saved=null;
 const service={pool:{query:async(sql,args)=>({rows:files.has(args[0])?[files.get(args[0])]:[]})},save:async(id,language,revision,buffer,user)=>{
  assert.equal(id,'123');assert.equal(language,'ar');assert.equal(revision,'a'.repeat(64));assert.equal(user,'admin');assert.deepEqual(buffer,png);inspect(buffer,'IMAGE');
  const id2='12345678-1234-4234-8234-123456789abc';files.set(id2,{content:buffer,mime_type:'image/png'});saved='/uploads/template-headers/'+id2;return {media:{url:saved,format:'IMAGE'}};
 }};
 const auth=(req,res,next)=>{req.user={username:'admin'};next();};registerTemplateMedia(app,{service,requireAuth:auth,requireConversationRole:auth,requireAdmin:auth,multer});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{const form=new FormData();form.append('revision','a'.repeat(64));form.append('file',new Blob([png],{type:'image/png'}),'عينة.png');
 const r=await fetch(base+'/api/whatsapp/template-media/123/ar',{method:'POST',body:form});assert.equal(r.status,200);assert.equal((await r.json()).media.url,saved);
 const publicFile=await fetch(base+saved);assert.equal(publicFile.status,200);assert.deepEqual(Buffer.from(await publicFile.arrayBuffer()),png);
 const range=await fetch(base+saved,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 0-7/${png.length}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),png.subarray(0,8));
 assert.equal((await fetch(base+saved,{headers:{Range:'bytes=1000-2000'}})).status,416);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
