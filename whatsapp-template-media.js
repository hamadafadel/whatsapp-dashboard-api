'use strict';
const {randomUUID,createHash}=require('node:crypto');
const https=require('node:https'),dns=require('node:dns').promises;
const {templateRevision}=require('./whatsapp-template-catalog');
// A conservative 16 MiB application cap for PDF (below Meta's maximum) keeps
// multipart + PostgreSQL bytea copies bounded on the existing API container.
const LIMITS={IMAGE:5*1024*1024,VIDEO:16*1024*1024,DOCUMENT:16*1024*1024};
const error=(code,status=422)=>Object.assign(new Error(code),{code,status});
function sampleUrl(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&(!u.port||u.port==='443')&&
 /(?:^|\.)(?:fbcdn\.net|fbsbx\.com|whatsapp\.net)$/.test(u.hostname)&&value.length<=4096?u:null;}catch{return null;}
}
function publicV4(ip){
 const n=ip.split('.').map(Number);return n.length===4&&n.every(x=>Number.isInteger(x)&&x>=0&&x<=255)&&
 !([0,10,127].includes(n[0])||n[0]>=224||(n[0]===169&&n[1]===254)||(n[0]===172&&n[1]>=16&&n[1]<=31)||
 (n[0]===192&&(n[1]===168||n[1]===0||n[1]===2))||(n[0]===100&&n[1]>=64&&n[1]<=127)||
 (n[0]===198&&(n[1]===18||n[1]===19||n[1]===51))||(n[0]===203&&n[1]===0&&n[2]===113));
}
// Only server-provided Meta CDN samples. No credentials, redirects, user URL or
// unchecked DNS resolution; pin the validated address for the actual TLS request.
async function downloadSample(value,max,{resolve=dns.resolve4,request=https.get}={}){
 const url=sampleUrl(value);if(!url)throw error('META_SAMPLE_UNAVAILABLE');
 const addresses=await resolve(url.hostname);if(!addresses.length||!addresses.every(publicV4))throw error('META_SAMPLE_UNAVAILABLE');
 return new Promise((resolve,reject)=>{
  let size=0;const chunks=[];
  const req=request(url,{agent:false,headers:{Accept:'image/jpeg,image/png,video/mp4,application/pdf'},
   lookup:(host,options,cb)=>cb(null,options?.all?[{address:addresses[0],family:4}]:addresses[0],4)},res=>{
   if(res.statusCode!==200||Number(res.headers['content-length'])>max){res.destroy();reject(error('META_SAMPLE_UNAVAILABLE'));return;}
   res.on('data',chunk=>{size+=chunk.length;if(size>max){res.destroy();reject(error('MEDIA_TOO_LARGE'));}else chunks.push(chunk);});
   res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',()=>reject(error('META_SAMPLE_UNAVAILABLE')));
  });
  req.setTimeout(20000,()=>req.destroy());req.on('error',()=>reject(error('META_SAMPLE_UNAVAILABLE')));
 });
}
function inspect(buffer,format){
 if(!Buffer.isBuffer(buffer)||!buffer.length||!LIMITS[format])throw error('INVALID_HEADER_MEDIA');
 if(buffer.length>LIMITS[format])throw error('MEDIA_TOO_LARGE');
 let mime;
 if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
 else if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255)mime='image/jpeg';
 else if(buffer.length>=12&&buffer.toString('ascii',4,8)==='ftyp'&&/^(?:isom|iso2|mp41|mp42|avc1|M4V )$/.test(buffer.toString('ascii',8,12)))mime='video/mp4';
 else if(buffer.toString('ascii',0,5)==='%PDF-')mime='application/pdf';
 if(!mime||({IMAGE:'image/',VIDEO:'video/',DOCUMENT:'application/pdf'}[format]!==mime&&!mime.startsWith({IMAGE:'image/',VIDEO:'video/',DOCUMENT:'application/pdf'}[format])))throw error('HEADER_MEDIA_TYPE_MISMATCH');
 return {mime,sha:createHash('sha256').update(buffer).digest('hex')};
}
class TemplateMedia {
 constructor({pool,catalog,download=downloadSample}){Object.assign(this,{pool,catalog,download});}
 async definition(id,language,revision){
  if(!/^\d{1,100}$/.test(id)||!/^[a-zA-Z]{2,3}(?:_[a-zA-Z0-9]{2,8})?$/.test(language))throw error('INVALID_TEMPLATE');
  const data=await this.catalog.list({fresh:true}),t=data.templates.find(t=>t.id===id&&t.language===language&&t.status==='APPROVED');
  if(!t)throw error('TEMPLATE_NO_LONGER_APPROVED');
  if(revision!==undefined&&templateRevision(t)!==revision)throw error('TEMPLATE_CHANGED_REFRESH_REQUIRED',409);
  const index=t.components.findIndex(c=>c.type==='HEADER'&&LIMITS[c.format]);
  if(index<0)throw error('TEMPLATE_HAS_NO_MEDIA_HEADER');
  return {t,format:t.components[index].format,index};
 }
 dto(row){return row?{url:'/uploads/template-headers/'+row.id,format:row.format,mimeType:row.mime_type,source:row.source}:null;}
 async get(id,language){
  const {t,format,index}=await this.definition(id,language);
  const row=(await this.pool.query(`SELECT f.id,f.format,f.mime_type,f.source FROM public.whatsapp_template_media_defaults d
   JOIN public.whatsapp_template_media_files f ON f.id=d.file_id AND f.format=d.format WHERE d.template_id=$1 AND d.language=$2 AND d.format=$3`,[id,language,format])).rows[0];
  return {media:this.dto(row),sampleAvailable:(t.mediaSamples?.[index]||[]).some(v=>sampleUrl(v)),format};
 }
 async save(id,language,revision,buffer,owner,source='upload'){
  if(!/^[a-f0-9]{64}$/.test(revision||''))throw error('TEMPLATE_REVISION_REQUIRED');
  const {format}=await this.definition(id,language,revision),{mime,sha}=inspect(buffer,format),fileId=randomUUID(),client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   await client.query(`INSERT INTO public.whatsapp_template_media_files(id,format,mime_type,content,sha256,created_by,source) VALUES($1,$2,$3,$4,$5,$6,$7)`,[fileId,format,mime,buffer,sha,owner,source]);
   await client.query(`INSERT INTO public.whatsapp_template_media_defaults(template_id,language,format,file_id) VALUES($1,$2,$3,$4)
    ON CONFLICT(template_id,language,format) ${source==='meta-sample'?'DO NOTHING':'DO UPDATE SET file_id=EXCLUDED.file_id,updated_at=now()'}`,[id,language,format,fileId]);
   const current=(await client.query(`SELECT f.id,f.format,f.mime_type,f.source FROM public.whatsapp_template_media_defaults d JOIN public.whatsapp_template_media_files f ON f.id=d.file_id WHERE d.template_id=$1 AND d.language=$2 AND d.format=$3`,[id,language,format])).rows[0];
   await client.query('COMMIT');return {media:this.dto(current)};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 async importSample(id,language,revision,owner){
  if(!/^[a-f0-9]{64}$/.test(revision||''))throw error('TEMPLATE_REVISION_REQUIRED');
  const {t,format,index}=await this.definition(id,language,revision);
  const url=(t.mediaSamples?.[index]||[]).find(v=>sampleUrl(v));if(!url)throw error('META_SAMPLE_UNAVAILABLE');
  // This does NOT send or upload anything to Meta; only downloads an example.
  return this.save(id,language,revision,await this.download(url,LIMITS[format]),owner,'meta-sample');
 }
}
function registerTemplateMedia(app,{service,requireAuth,requireConversationRole,requireAdmin,multer}){
 const fail=(res,e)=>res.status(e.status||503).json({error:e.code||'TEMPLATE_MEDIA_NOT_READY',message:'تعذر حفظ ميديا القالب؛ لم يتم إرسال أي رسالة.'});
 const route='/api/whatsapp/template-media/:id/:language';
 app.get(route,requireAuth,requireConversationRole,async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await service.get(req.params.id,req.params.language));}catch(e){fail(res,e);}});
 // Shared defaults affect all operators: changes are administrator-only.
 let active=0;
 const guard=(req,res,next)=>{if(active>=2)return res.status(429).json({error:'MEDIA_UPLOAD_BUSY'});active++;let done=false;const finish=()=>{if(!done){done=true;active--;}};res.once('close',finish);res.once('finish',finish);next();};
 const upload=multer({storage:multer.memoryStorage(),limits:{files:1,fields:1,fileSize:LIMITS.DOCUMENT,fieldSize:128}}).single('file');
 app.post(route,requireAuth,requireAdmin,guard,(req,res,next)=>upload(req,res,e=>e?fail(res,error('MEDIA_UPLOAD_REJECTED',413)):next()),async(req,res)=>{
  try{res.json(await service.save(req.params.id,req.params.language,req.body.revision,req.file?.buffer,req.user.username));}catch(e){fail(res,e);}
 });
 app.post(route+'/meta-sample',requireAuth,requireAdmin,guard,async(req,res)=>{
  try{res.json(await service.importSample(req.params.id,req.params.language,req.body?.revision,req.user.username));}catch(e){fail(res,e);}
 });
 // Unpredictable immutable URL, intentionally readable by WhatsApp without JWT.
 // No filename/original customer data is exposed. Existing /uploads URLs stay unchanged.
 app.get('/uploads/template-headers/:id',async(req,res)=>{
  if(!/^[a-f0-9-]{36}$/.test(req.params.id))return res.sendStatus(404);
  try{const row=(await service.pool.query('SELECT content,mime_type FROM public.whatsapp_template_media_files WHERE id=$1',[req.params.id])).rows[0];
   if(!row)return res.sendStatus(404);res.set({'Content-Type':row.mime_type,'X-Content-Type-Options':'nosniff','Cache-Control':'public,max-age=31536000,immutable','Content-Disposition':'inline','Accept-Ranges':'bytes','Content-Security-Policy':'sandbox','Referrer-Policy':'no-referrer'});
   const size=row.content.length;
   if(req.headers.range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    let start=match?.[1]?Number(match[1]):0,end=match?.[2]?Number(match[2]):size-1;
    if(match&&!match[1]&&match[2]){start=Math.max(0,size-Number(match[2]));end=size-1;}
    if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return res.status(416).set('Content-Range',`bytes */${size}`).end();
    end=Math.min(end,size-1);res.status(206).set({'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':String(end-start+1)});return res.send(row.content.subarray(start,end+1));
   }
   res.set('Content-Length',String(size));res.send(row.content);
  }catch{res.sendStatus(503);}
 });
}
module.exports={TemplateMedia,registerTemplateMedia,inspect,sampleUrl,publicV4,downloadSample,LIMITS};
