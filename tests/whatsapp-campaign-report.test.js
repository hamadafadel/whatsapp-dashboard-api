'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {enrich,summarize,xlsxReport}=require('../whatsapp-campaign-report');
const states=['pending','queued','sending','sent','delivered','read','failed','unknown','excluded'];
const recipients=states.map((s,i)=>({name:i===0?'=HYPERLINK("bad")':'عميل تجريبي 😀',phone:'120255501'+String(10+i),state:s,delivery_status:['delivered','read','failed'].includes(s)?s:null,delivery_at:['delivered','read','failed'].includes(s)?'2026-11-24T08:03:00.000Z':null,updated_at:'2026-11-24T08:01:00.000Z',sources:['Label تجريبي']})).map(r=>enrich(r));
test('summary separates unresolved/remaining/excluded; delivery and read are nested in sent',()=>assert.deepEqual(summarize(recipients),{total:9,sent:3,remaining:3,excluded:1,failed:1,unknown:1,delivered:2,read:1,processed:6,progress:67}));
test('Meta acceptance alone is never delivery or read',()=>{const r=enrich({state:'sent',message_id:'wamid.SYNTHETIC'});assert.equal(r.status,'sent');assert.equal(summarize([r]).delivered,0);assert.equal(summarize([r]).read,0);});
test('status timing belongs to selected event; failure code remains available',()=>{const r=enrich({state:'sent',delivery_status:'failed',delivery_error_code:131026,delivery_at:'2026-11-24T08:03:00Z',queue_updated_at:'2026-11-24T08:01:00Z'});assert.equal(r.status_at,'2026-11-24T08:03:00Z');assert.equal(r.failure_reason,'META_ERROR_131026');});
test('cancelled remaining recipient is excluded, never marked sent',()=>assert.equal(enrich({state:'pending'},{state:'cancelled'}).status,'excluded'));
test('actual XLSX roundtrip preserves phone text, Unicode, dates and treats formula-like names as text',async()=>{
 const c={id:'synthetic',title:'حملة تجريبية',created_at:'2026-11-24T08:00:00Z',template:{name:'test',language:'ar'}};
 const bytes=xlsxReport({campaign:c,recipients}),{readSheet}=require('read-excel-file/node'),rows=await readSheet(bytes);
 assert.equal(bytes.subarray(0,2).toString(),'PK');assert.equal(rows[6][0],'=HYPERLINK("bad")');assert.equal(typeof rows[6][1],'string');assert(rows[1][1] instanceof Date);assert(Math.abs(rows[1][1].getTime()-Date.parse(c.created_at))<=2,'Excel serial roundtrip is accurate within floating-point milliseconds');assert.equal(rows[7][0],'عميل تجريبي 😀');
 const {unzipSync,strFromU8}=require('fflate'),sheet=strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']);assert(!sheet.includes('<f>'));assert(sheet.includes('rightToLeft="1"'));
});
