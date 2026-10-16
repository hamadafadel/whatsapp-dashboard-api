'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
const start=source.indexOf('// BEGIN INSTAGRAM INLINE CHANNEL');
const end=source.indexOf('// END INSTAGRAM INLINE CHANNEL',start);
assert.ok(start>=0&&end>start);
const {prepareInstagramSendRequest:prepare,createInstagramService}=new Function('crypto','process','fetch','AbortSignal',
 source.slice(start,end)+'\nreturn createInstagramChannelHelpers();')(crypto,{env:{}},()=>{throw Error('REAL_NETWORK_DISABLED_IN_TEST');},AbortSignal);
const mid='META_TEST_ORIGINAL_MID',sid='ig:10001:20001',now=1700000000000;
const request=(extra={})=>({channel:'instagram',sessionId:sid,requestId:'11111111-1111-4111-8111-111111111111',message:'Synthetic reply أهلا',replyTo:{external_message_id:mid},...extra});
for(const kind of ['text','image','video','audio'])test('IG '+kind+' places quoted MID at top level without changing message payload',()=>{
 const r=prepare(request({messageKind:kind,mediaUrl:'https://wadashboardapi.almehrab.org/uploads/test.'+kind}),{accountId:'10001'});
 assert.deepEqual(r.sendPayload.reply_to,{mid});assert.equal(r.sendPayload.message.reply_to,undefined);
 assert.equal(r.prepared.reply_to.external_message_id,mid);
 const ordinary=prepare(request({messageKind:kind,mediaUrl:'https://wadashboardapi.almehrab.org/uploads/test.'+kind,replyTo:null}),{accountId:'10001'});
 assert.deepEqual(r.sendPayload.message,ordinary.sendPayload.message);assert.ok(!('reply_to'in ordinary.sendPayload));
});

test('Instagram media/voice forwards quote, retains login on permission 403 and clears quote only on success',()=>{
 const source=fs.readFileSync('app.js','utf8');
 const media=source.slice(source.indexOf('async function uploadMediaFile('),source.indexOf('async function queueComposerMediaFiles('));
 const audio=source.slice(source.indexOf('function sendRecordedAudio('));
 assert.match(media,/formData\.append\("replyTo", JSON\.stringify\(instagramMediaReply\)\)/);
 assert.match(audio,/formData\.append\("replyTo", JSON\.stringify\(instagramAudioReply\)\)/);
 assert.ok(media.includes('xhr.status === 403 && getChannelFromSessionId(targetSessionId) !== "instagram"'));
 assert.ok(audio.includes('xhr.status === 403 && !String(formData.get("sessionId")).startsWith("ig:")'));
 assert.ok(media.includes('selectedReplyMessage === instagramMediaReply'));
 assert.ok(audio.includes('selectedReplyMessage === instagramAudioReply'));
 assert.match(fs.readFileSync('index.html','utf8'),/app\.js\?v=71/);
});

for(const replyTo of [{id:42},{wa_message_id:'42'},{external_message_id:'ig-postback:FAKE'},
 {external_message_id:'ig-referral:FAKE'},{external_message_id:'ig:10001:20001'},{external_message_id:'fb:20001'},
 {external_message_id:'wamid.TEST'},{external_message_id:'MID WITH SPACE'},
 {external_message_id:mid,channel_message_id:'OTHER_MID'},'invalid',[],{external_message_id:mid,sessionId:'ig:10001:30001'}])
 test('invalid/foreign/synthetic reply target is rejected before network: '+JSON.stringify(replyTo),()=>{
 assert.throws(()=>prepare(request({replyTo}),{accountId:'10001'}));
});
function service(hasTarget=true){
 const calls=[],queries=[];const s=createInstagramService({env:{INSTAGRAM_ACCOUNT_ID:'10001',INSTAGRAM_OUTBOUND_ENABLED:'true',N8N_IG_SEND_WEBHOOK_URL:'https://n8n.almehrab.org/webhook/dashboard-send-ig',INTERNAL_API_TOKEN:'SYNTHETIC_ONLY'},now:()=>now,
 pool:{async query(sql,args){queries.push({sql,args});if(sql.startsWith('SELECT message'))return {rows:hasTarget?[{message:{type:'user',content:'Trusted original',message_kind:'text',media_url:''}}]:[]};return {rows:[{last_user_message_at:new Date(now-1000).toISOString()}]};}},
 fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);calls.push(body);return {ok:true,json:async()=>({success:true,message_id:'META_TEST_NEW_MID',storage_id:'42',requestId:body.requestId})};}});
 return {s,calls,queries};
}
test('same-session reply lookup precedes sending and replaces client-supplied quote content',async()=>{
 const f=service();await f.s.send(request({replyTo:{external_message_id:mid,content:'UNTRUSTED_CLIENT_TEXT'}}));
 assert.equal(f.calls.length,1);assert.deepEqual(f.queries[0].args,[sid,mid]);
 assert.match(f.queries[0].sql,/session_id=\$1/);assert.match(f.queries[0].sql,/channel'='instagram'/);
 assert.match(f.queries[0].sql,/is_deleted/);assert.match(f.queries[0].sql,/DISTINCT FROM 'reaction'/);
 assert.equal(f.calls[0].replyTo.content,'Trusted original');assert.equal(f.calls[0].replyTo.mid,mid);
});
test('missing or other-session MID returns 403 without contacting n8n',async()=>{
 const f=service(false);await assert.rejects(f.s.send(request()),e=>e.status===403);assert.equal(f.calls.length,0);
});
test('normal Instagram send retains one window query and no quote',async()=>{
 const f=service();await f.s.send(request({replyTo:null}));assert.equal(f.queries.length,1);assert.equal(f.calls[0].replyTo,null);
});

