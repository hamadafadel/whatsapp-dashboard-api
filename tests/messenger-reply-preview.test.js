'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { hydrateMessengerReplies } = require('../messenger-reply-preview');
const session = 'fb:fixture';
const incoming = () => [{id:20,session_id:session,message:{type:'user',channel:'messenger',
  content:'reply',reply_to:{external_message_id:'m_original'}}}];
const target = (kind='image',type='agent') => ({id:10,session_id:session,message:{
  channel:'messenger',type,channel_message_id:'m_original',message_kind:kind,
  content:kind==='text'?'original text':'',media_url:'https://example.invalid/original',
  thumbnail_url:'https://example.invalid/thumbnail'}});
function db(rows) {return {calls:0,async query(sql,params){
  this.calls++;assert.match(sql,/WHERE session_id = \$1/);
  assert.deepEqual(params,[session,['m_original']]);return {rows};
}};}
for(const kind of ['image','video','text','audio','file']) for(const type of ['agent','user'])
test('resolve '+type+' '+kind+' through exact MID in same conversation',async()=>{
  const input=incoming(),before=JSON.stringify(input),pool=db([target(kind,type)]);
  const out=await hydrateMessengerReplies(pool,session,input);
  assert.equal(pool.calls,1);assert.equal(out[0].message.reply_to.message_kind,kind);
  assert.equal(out[0].message.reply_to.type,type);assert.equal(out[0].message.reply_to.unresolved,false);
  assert.equal(JSON.stringify(input),before);
});
test('WhatsApp and Instagram bypass Messenger lookup without changing references',async()=>{
  const pool={query(){throw Error('must not query')}},rows=incoming();
  for(const sid of ['123','ig:fixture'])assert.equal(await hydrateMessengerReplies(pool,sid,rows),rows);
});
test('missing, ambiguous, self-referencing, deleted or cross-session targets never quote another message',async()=>{
  for(const targets of [[],[target(),{...target(),id:11}],[{...target(),id:20}],
    [{...target(),session_id:'fb:other'}],[{...target(),message:{...target().message,is_deleted:true}}]]){
    const out=await hydrateMessengerReplies(db(targets),session,incoming());
    assert.equal(out[0].message.reply_to.unresolved,true);
    assert.equal(out[0].message.reply_to.media_url,undefined);
  }
});
test('raw canonical MID and normalized attachments supply original image without name/time matching',async()=>{
  const row=target();row.message={type:'user',raw_message:{message:{mid:'m_original'}},
    attachments:[{type:'image',payload:{url:'https://example.invalid/photo'}}]};
  const out=await hydrateMessengerReplies(db([row]),session,incoming());
  assert.equal(out[0].message.reply_to.media_url,'https://example.invalid/photo');
});
test('lookup failure degrades to missing preview but keeps the new message readable',async()=>{
  const out=await hydrateMessengerReplies({query:async()=>{throw Error('synthetic')}},session,incoming());
  assert.equal(out[0].message.content,'reply');assert.equal(out[0].message.reply_to.unresolved,true);
});
test('unsafe media URLs cannot enter quoted media',async()=>{
  for(const url of ['javascript:alert(1)','https://user:pass@example.invalid/photo']){
    const row=target();row.message.media_url=url;
    assert.equal((await hydrateMessengerReplies(db([row]),session,incoming()))[0].message.reply_to.media_url,'');
  }
});
test('no reply does not add a database request',async()=>{
  const rows=[{message:{content:'ordinary'}}],pool=db([]);
  assert.equal(await hydrateMessengerReplies(pool,session,rows),rows);assert.equal(pool.calls,0);
});
test('a conflicting identity alias or explicit different channel never becomes a quote',async()=>{
  for(const message of [
    {...target().message,external_message_id:'m_other'},
    {...target().message,channel:'instagram'}
  ]){
    const out=await hydrateMessengerReplies(db([{...target(),message}]),session,incoming());
    assert.equal(out[0].message.reply_to.unresolved,true);
  }
  const rows=incoming();rows[0].message.channel='instagram';
  const pool=db([]);assert.equal((await hydrateMessengerReplies(pool,session,rows))[0],rows[0]);
  assert.equal(pool.calls,0);
});
test('a full page batches distinct references into one session-scoped lookup',async()=>{
  const rows=Array.from({length:100},(_,i)=>({id:200+i,message:{channel:'messenger',
    reply_to:{external_message_id:'m_'+(i%20)}}}));
  let queries=0;
  const out=await hydrateMessengerReplies({query:async(sql,params)=>{
    queries++;assert.equal(params[0],session);assert.equal(params[1].length,20);
    assert.match(sql,/WHERE session_id = \$1/);return {rows:[]};
  }},session,rows);
  assert.equal(queries,1);assert.equal(out.length,100);
});
