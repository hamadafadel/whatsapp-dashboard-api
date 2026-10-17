'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
const start=source.indexOf('// BEGIN INSTAGRAM INLINE CHANNEL');
const end=source.indexOf('// END INSTAGRAM INLINE CHANNEL',start);
assert.ok(start>=0&&end>start);
const {prepareInstagramSendRequest:prepare,createInstagramService}=new Function('crypto','process','fetch','AbortSignal',
 source.slice(start,end)+'\nreturn createInstagramChannelHelpers();')(crypto,{env:{}},()=>{throw Error('REAL_NETWORK_DISABLED_IN_TEST');},AbortSignal);
const mid='META_TEST_ORIGINAL_MID',sid='ig:10001:20001',id='11111111-1111-4111-8111-111111111111';
const input=(extra={})=>({channel:'instagram',sessionId:sid,requestId:id,messageKind:'reaction',messageId:mid,emoji:'❤️',...extra});
for(const emoji of ['❤️','❤','♥','♥️'])test('heart '+emoji+' maps to normalized direct emoji without message object',()=>{
 const r=prepare(input({emoji}),{accountId:'10001'});
 assert.deepEqual(r.sendPayload,{recipient:{id:'20001'},sender_action:'react',payload:{message_id:mid,reaction:'❤️'}});
 assert.ok(!('message'in r.sendPayload));assert.ok(!('messaging_type'in r.sendPayload));
});
for(const emoji of ['like','love',null,undefined,'plain text','❤️👍'])test('unsupported/unverified selection fails closed: '+emoji,()=>{
 assert.throws(()=>prepare(input({emoji}),{accountId:'10001'}),e=>e.httpStatus===422);
});
for(const messageId of ['42','ig-postback:FAKE','ig-referral:FAKE','ig:10001:20001','fb:20001','wamid.TEST','MID WITH SPACE',''])
 test('non-Meta target rejected: '+messageId,()=>assert.throws(()=>prepare(input({messageId}),{accountId:'10001'})));
function fixture({target=true,ack='correct'}={}){
 const requests=[],queries=[],now=1700000000000;
 const service=createInstagramService({env:{INSTAGRAM_ACCOUNT_ID:'10001',INSTAGRAM_OUTBOUND_ENABLED:'true',N8N_IG_SEND_WEBHOOK_URL:'https://n8n.almehrab.org/webhook/dashboard-send-ig',INTERNAL_API_TOKEN:'SYNTHETIC_ONLY'},now:()=>now,
 pool:{async query(sql,args){queries.push({sql,args});return sql.startsWith('SELECT message')?{rows:target?[{message:{type:'user',content:'Synthetic',message_kind:'text'}}]:[]}:{rows:[{last_user_message_at:new Date(now-1000).toISOString()}]};}},
 fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);requests.push(body);return {ok:true,json:async()=>({success:true,channel:'instagram',messageKind:ack==='plain'?'text':'reaction',message_id:ack==='wrongMID'?'DIFFERENT_MID':mid,requestId:body.requestId,storage_id:ack==='noStorage'?null:'42',emoji:body.emoji})};}});
 return {service,requests,queries};
}
test('service validates target within same IG session and returns confirmed reaction, not new message',async()=>{
 const f=fixture(),r=await f.service.send(input());assert.equal(f.requests.length,1);assert.equal(r.messageKind,'reaction');assert.equal(r.message_id,mid);
 assert.deepEqual(f.queries[0].args,[sid,mid]);assert.match(f.queries[0].sql,/channel'='instagram'/);assert.match(f.queries[0].sql,/is_deleted/);
 assert.equal(f.requests[0].emoji,'❤️');assert.equal(f.requests[0].messageId,mid);
});
test('foreign/missing target performs no HTTP request',async()=>{const f=fixture({target:false});await assert.rejects(f.service.send(input()),e=>e.status===403);assert.equal(f.requests.length,0);});
for(const ack of ['plain','wrongMID','noStorage'])test('uncertain/wrong persistence acknowledgement is not retried: '+ack,async()=>{
 const f=fixture({ack});await assert.rejects(f.service.send(input()),/persistence was not confirmed/);assert.equal(f.requests.length,1);
});

test('Unreact omits reaction field and accepts empty emoji acknowledgement without creating a message',async()=>{
 const p=prepare(input({emoji:''}),{accountId:'10001'});assert.deepEqual(p.sendPayload,{recipient:{id:'20001'},sender_action:'unreact',payload:{message_id:mid}});
 const f=fixture(),r=await f.service.send(input({emoji:''}));assert.equal(r.emoji,'');assert.equal(r.message_id,mid);assert.equal(f.requests.length,1);
});
test('emoji grapheme validation rejects multi-emoji, whitespace, names and markup',()=>{
 for(const emoji of ['❤️👍','like','love','🙏 🌹','<img>','x','\n'])assert.throws(()=>prepare(input({emoji}),{accountId:'10001'}));
 assert.equal(prepare(input({emoji:'👍🏽'}),{accountId:'10001'}).sendPayload.payload.reaction,'👍🏽');
});
test('Meta rejection of an untested emoji is explicit and never reports success or retries',async()=>{
 let calls=0;const service=createInstagramService({env:{INSTAGRAM_ACCOUNT_ID:'10001',INSTAGRAM_OUTBOUND_ENABLED:'true',N8N_IG_SEND_WEBHOOK_URL:'https://n8n.almehrab.org/webhook/dashboard-send-ig',INTERNAL_API_TOKEN:'SYNTHETIC_ONLY'},now:()=>1700000000000,
 pool:{async query(sql){return sql.startsWith('SELECT message')?{rows:[{message:{type:'user'}}]}:{rows:[{last_user_message_at:'2023-11-14T22:13:19Z'}]};}},
 fetchImpl:async()=>{calls++;return {ok:false,json:async()=>({success:false,errorCode:'META_REJECTED'})};}});
 await assert.rejects(service.send(input({emoji:'⭐'})),e=>e.status===422&&/Meta rejected/.test(e.message));assert.equal(calls,1);
});

