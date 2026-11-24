'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
test('patched HTTP parser rejects malformed compressed input without killing the API process',()=>{
 assert.equal(require('body-parser/package.json').version,'1.20.9');
 const code=`const express=require('express'),z=require('node:zlib');const a=express();a.use(express.json());a.post('/synthetic',(q,r)=>r.json({ok:true}));a.get('/alive',(q,r)=>r.json({ok:true}));a.use((e,q,r,n)=>r.status(400).json({error:'INVALID_BODY'}));const s=a.listen(0,'127.0.0.1',async()=>{try{const base='http://127.0.0.1:'+s.address().port;await fetch(base+'/synthetic',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body:Buffer.concat([z.gzipSync(Buffer.from('{}')),Buffer.from('TRAILING_GZIP_BYTES')])});const check=await fetch(base+'/alive');if(check.status!==200)throw Error('NOT_ALIVE');console.log('PATCHED_PARSER_ALIVE');}catch{process.exitCode=1}finally{s.closeAllConnections();s.close()}});`;
 const r=spawnSync(process.execPath,['-e',code],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(r.status,0);assert.match(r.stdout,/PATCHED_PARSER_ALIVE/);
});
test('patched proxy matching does not trust an unrelated IPv4-mapped IPv6 address',()=>{
 assert.equal(require('proxy-addr/package.json').version,'2.0.8');const trust=require('proxy-addr').compile(['10.0.0.0/8']);
 assert.equal(trust('::ffff:203.0.113.1',0),false);assert.equal(trust('::ffff:10.0.0.1',0),true);
});
test('scoped qs patch retains scalar queries and blocks prototype pollution',()=>{
 const q=require('qs');assert.equal(require('qs/package.json').version,'6.16.2');
 assert.deepEqual(q.parse('q=Arabic&offset=50'),{q:'Arabic',offset:'50'});
 q.parse('__proto__[campaignPolluted]=yes&constructor[prototype][campaignPolluted]=yes');assert.equal({}.campaignPolluted,undefined);
});
