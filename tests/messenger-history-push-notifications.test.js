'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const deps=process.env.MESSENGER_DIAGNOSTIC_TEST_DEPS;
const expressPath=deps?path.join(deps,'node_modules/express'):'express';
assert.equal(require(expressPath+'/package.json').version,require('../package-lock.json').packages['node_modules/express'].version);
const express=require(expressPath);
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8').replace(/\r\n/g,'\n');
const route=source.slice(source.indexOf("app.post('/api/push-update'"),source.indexOf('async function getCustomerNameForSession'));
function functionSource(start){const begin=source.indexOf(start),end=source.indexOf('\n}\n',begin);assert.ok(begin>=0&&end>begin);return source.slice(begin,end+3);}
const sendSource=functionSource('async function sendNewMessagePush(');
const broadcastSource=functionSource('function broadcastDashboardEvent(');
const input=(i=1,extra={})=>({type:'new_message',messageType:'user',channel:'messenger',sessionId:'fb:200',messageId:'SYNTHETIC_'+i,storage_id:i,content:'SYNTHETIC',timestamp:'2020-01-01T00:00:00Z',...extra});
async function fixture(t){
 const app=express(),sse=[],notifications=[],access=[],names=[];
 const clients=new Set([{username:'SYNTHETIC_ADMIN',res:{destroyed:false,writableEnded:false,write:chunk=>sse.push(JSON.parse(chunk.slice(6))),end(){}}}]);
 const context={app,clients,process:{env:{DASHBOARD_SECRET:'SYNTHETIC_ONLY'}},console:{log(){},error(){}},
  findDashboardAccountByUsername:()=>({role:'admin'}),canDashboardUserAccessConversation:()=>true,
  getConversationAccessState:async sid=>{access.push(sid);return {};},
  getCustomerNameForSession:async sid=>{names.push(sid);return 'SYNTHETIC';},
  buildPushBodyText:p=>p.content,
  sendPushToAllSubscriptions:async (p,options)=>notifications.push({payload:p,options})};
 vm.createContext(context);
 vm.runInContext('let dashboardBroadcastQueue=Promise.resolve();\n'+broadcastSource+'\n'+sendSource,context);
 app.use(express.json());vm.runInContext(route,context);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));});
 return {sse,notifications,access,names,context,async post(payload,valid=true){
  const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/push-update',{method:'POST',headers:{'Content-Type':'application/json','x-dashboard-secret':valid?'SYNTHETIC_ONLY':'WRONG_SYNTHETIC'},body:JSON.stringify(payload)});
  const body=await res.json();await vm.runInContext('dashboardBroadcastQueue',context);await new Promise(setImmediate);
  return {status:res.status,body};
 }};
}
test('100 historical user messages: 100 actual SSE frames, no push or push-name lookups',async t=>{
 const f=await fixture(t);
 for(let i=0;i<100;i++)assert.deepEqual(await f.post(input(i,{source:'history_sync'})),{status:200,body:{sent:true}});
 assert.equal(f.sse.length,100);assert.equal(f.notifications.length,0);assert.equal(f.names.length,0);
 assert.deepEqual(f.sse.map(p=>p.messageId),Array.from({length:100},(_,i)=>'SYNTHETIC_'+i));
 assert.ok(f.sse.every(p=>p.source==='history_sync'&&p.content==='SYNTHETIC'));
});
test('new message in the same session during history sync still notifies once',async t=>{
 const f=await fixture(t);
 await Promise.all(Array.from({length:100},(_,i)=>f.post(input(i,{source:'history_sync'}))).concat(f.post(input(101,{timestamp:'2026-01-01T00:00:00Z'}))));
 assert.equal(f.sse.length,101);assert.equal(f.notifications.length,1);
 assert.equal(f.notifications[0].payload.sessionId,'fb:200');
});
test('repeated/retried history events can never produce duplicate push notifications',async t=>{
 const f=await fixture(t);
 const event=input(1,{source:'history_sync'});for(let i=0;i<3;i++)await f.post(event);
 assert.equal(f.notifications.length,0);assert.equal(f.sse.length,3);
 // SSE retry/dedup semantics are deliberately unchanged; no new persistence is added.
});
test('direct sendNewMessagePush calls also suppress history before any database lookup',async t=>{
 const f=await fixture(t);
 await f.context.sendNewMessagePush('fb:200',input(1,{source:'history_sync'}));
 assert.equal(f.notifications.length,0);assert.equal(f.names.length,0);assert.equal(f.access.length,0);
});
for(const [channel,sessionId]of [['whatsapp','200'],['messenger','fb:200'],['instagram','ig:100:200']]){
 test('ordinary '+channel+' customer notification remains unchanged',async t=>{
  const f=await fixture(t);await f.post(input(1,{channel,sessionId}));
  assert.equal(f.notifications.length,1);assert.equal(f.sse.length,1);assert.equal(f.notifications[0].payload.sessionId,sessionId);
 });
}
test('no age-based suppression: live-source old timestamp notifies; history-source current timestamp does not',async t=>{
 const f=await fixture(t);
 await f.post(input(1,{timestamp:'2000-01-01T00:00:00Z'}));
 await f.post(input(2,{source:'history_sync',timestamp:new Date().toISOString()}));
 assert.equal(f.notifications.length,1);assert.equal(f.sse.length,2);
});
test('agent Echo, reactions and invalid auth keep existing behavior',async t=>{
 const f=await fixture(t);
 await f.post(input(1,{messageType:'agent'}));await f.post(input(2,{type:'reaction'}));
 assert.deepEqual(await f.post(input(3),false),{status:401,body:{error:'Unauthorized'}});
 assert.equal(f.notifications.length,0);assert.equal(f.sse.length,2);
});
