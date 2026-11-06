'use strict';
const crypto=require('crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES=new Set(['admin','agent','confirmation']);
function fault(code,status=400){return Object.assign(new Error(code),{code,status});}
function hash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function secretHash(secret){
 if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(secret)||Buffer.from(secret,'base64url').length!==32||Buffer.from(secret,'base64url').toString('base64url')!==secret)throw fault('INVALID_DEVICE_SECRET');
 return hash(secret);
}
function sameHash(a,b){return typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function tokenKey(env){
 const value=env.ANDROID_PUSH_TOKEN_ENCRYPTION_KEY;
 if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))throw fault('ANDROID_PUSH_KEY_UNAVAILABLE',503);
 const key=Buffer.from(value,'base64');if(key.length!==32)throw fault('ANDROID_PUSH_KEY_UNAVAILABLE',503);return key;
}
function encryptToken(token,bindingId,env){
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',tokenKey(env),iv);
 cipher.setAAD(Buffer.from(bindingId));const body=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
 return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),body.toString('base64')].join('.');
}
function decryptToken(value,bindingId,env){
 try{const [v,iv,tag,body,...extra]=value.split('.');if(v!=='v1'||extra.length)throw Error();const decipher=crypto.createDecipheriv('aes-256-gcm',tokenKey(env),Buffer.from(iv,'base64'));decipher.setAAD(Buffer.from(bindingId));decipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(body,'base64')),decipher.final()]).toString('utf8');}
 catch{throw fault('ANDROID_PUSH_TOKEN_UNAVAILABLE',503);}
}
function liveMessage(row){
 const m=row?.message||{},sid=row?.session_id;
 const channel=typeof sid==='string'?(sid.startsWith('fb:')?'messenger':sid.startsWith('ig:')?'instagram':'whatsapp'):'';
 const ig=channel==='instagram'?/^ig:(\d+):(\d+)$/.exec(sid):null;
 const verifiedInstagram=Boolean(ig&&ig[1]!==ig[2]&&row.channel==='instagram'&&row.origin==='live_instagram_webhook'&&m.channel==='instagram'&&m.ig_account_id===ig[1]&&m.external_user_id===ig[2]);
 const history=[m.message_source,m.source,m.canonical_source].some(s=>['history_sync','graph_sync','graph','echo','business_suite'].includes(String(s||'').toLowerCase()));
 const mid=String(m.external_message_id||m.channel_message_id||m.wa_message_id||m.message_id||m.messenger_mid||m.whatsapp_message?.id||'').trim();
 return Boolean(sid&&['whatsapp','messenger','instagram'].includes(channel)&&(channel!=='instagram'||verifiedInstagram)&&(!row.channel||row.channel===channel)&&(!m.channel||m.channel===channel)&&['user','human'].includes(m.type)&&mid&&
  !['reaction','ai_typing'].includes(m.message_kind)&&m.is_deleted!==true&&(!history||verifiedInstagram)&&(!row.message_mid||row.message_mid===mid));
}
function previewBody(message){
 const text=String(message.caption||message.content||'').trim();
 const igPlaceholder=message.channel==='instagram'&&message.message_kind!=='text'&&/^\[Instagram [a-z]+\]$/i.test(text);
 if(text&&!igPlaceholder&&!/^__[a-z_]+__$/i.test(text)&&!(message.message_kind!=='text'&&/^https?:\/\//i.test(text)))return Array.from(text).slice(0,120).join('');
 return ({image:'📷 صورة',video:'🎥 فيديو',audio:'🎙️ رسالة صوتية',file:'📄 ملف',document:'📄 ملف',sticker:'🖼️ ملصق',location:'📍 موقع',share:'🔗 مشاركة',mixed:'📎 مرفقات',unsupported:'📩 رسالة غير مدعومة'})[message.message_kind]||'📩 رسالة جديدة';
}
function createAndroidPushService({store,findAccount,getAccess,canAccess,getCustomerName=async()=>'',env=process.env,now=Date.now}){
 async function currentUser(identity){
  const user=identity&&findAccount(identity.username);
  if(!user||!ROLES.has(user.role))throw fault('ANDROID_PUSH_FORBIDDEN',403);
  return user;
 }
 function usable(device){return Boolean(device&&!device.revoked_at&&device.notifications_enabled&&new Date(device.expires_at).getTime()>now());}
 async function register(identity,installationId,body,cancel=false){
  const user=await currentUser(identity);
  if(!Number.isFinite(identity.exp)||identity.exp*1000<=now())throw fault('SESSION_EXPIRED',401);
  if(!UUID.test(installationId)||!body||Array.isArray(body)||Object.keys(body).some(k=>!['fcmToken','deviceSecret','notificationsEnabled','expectedRevision','requestId'].includes(k)))throw fault('INVALID_DEVICE_REGISTRATION');
  if(typeof body.fcmToken!=='string'||body.fcmToken.length<20||body.fcmToken.length>4096||/\s|[\x00-\x1f]/.test(body.fcmToken)||typeof body.notificationsEnabled!=='boolean'||!UUID.test(body.requestId)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||body.expectedRevision>=Number.MAX_SAFE_INTEGER)throw fault('INVALID_DEVICE_REGISTRATION');
  const proof=secretHash(body.deviceSecret),bindingId=crypto.randomUUID();
  const requestDigest=hash(JSON.stringify([user.username,hash(body.fcmToken),proof,body.notificationsEnabled,identity.exp,body.expectedRevision]));
  const params={installationId,owner:user.username,proof,tokenHash:hash(body.fcmToken),bindingId,
   token:body.fcmToken,encrypt:(id)=>encryptToken(body.fcmToken,id,env),enabled:body.notificationsEnabled,expiresAt:new Date(identity.exp*1000),revision:body.expectedRevision,requestId:body.requestId,requestDigest};
  if(cancel){await store.cancelRegistration(params);return;}
  const row=await store.register(params);
  return {bindingId:row.binding_id,revision:Number(row.revision),expiresAt:row.expires_at,notificationsEnabled:row.notifications_enabled};
 }
 async function authenticateDevice(header,{allowExpired=false}={}){
  const match=typeof header==='string'&&header.match(/^Device ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i);
  if(!match||!UUID.test(match[1]))throw fault('INVALID_DEVICE_AUTH',401);
  let proof;try{proof=secretHash(match[2]);}catch{throw fault('INVALID_DEVICE_AUTH',401);}
  const device=await store.getDevice(match[1]);
  if(!device||!sameHash(device.secret_hash,proof))throw fault('INVALID_DEVICE_AUTH',401);
  if(!allowExpired&&!usable(device))throw fault('DEVICE_SESSION_EXPIRED',401);
  return device;
 }
 async function revoke(header){const device=await authenticateDevice(header,{allowExpired:true});await store.revoke(device.binding_id);}
 async function installationState(identity,id,body){
  await currentUser(identity);if(!UUID.test(id)||!body||Object.keys(body).some(k=>k!=='deviceSecret'))throw fault('INVALID_DEVICE_REGISTRATION');
  const proof=secretHash(body.deviceSecret),row=await store.installation(id);
  if(row&&!sameHash(row.secret_hash,proof))throw fault('DEVICE_CONFLICT',409);
  return {revision:Number(row?.revision||0)};
 }
 async function canDeliver(device,event){
  if(!usable(device)||new Date(event.expires_at).getTime()<=now())return false;
  const user=findAccount(device.owner_name);if(!user||!ROLES.has(user.role))return false;
  return canAccess(user,await getAccess(event.session_id));
 }
 async function preview(header,eventId){
  if(!UUID.test(eventId))throw fault('NOTIFICATION_NOT_FOUND',404);
  const device=await authenticateDevice(header);await currentUser({username:device.owner_name});
  const row=await store.preview(eventId,device.binding_id);
  if(!row||!liveMessage(row)||new Date(row.expires_at).getTime()<=now())throw fault('NOTIFICATION_NOT_FOUND',404);
  if(!await canDeliver(device,row))throw fault('ANDROID_PUSH_FORBIDDEN',403);
  const message=row.message;
  const savedName=String(message.customer_name||'').trim();
  const customerName=String(savedName&&!['عميل','Messenger User','WhatsApp User','Instagram User'].includes(savedName)?savedName:await getCustomerName(row.session_id)||message.customer_username||'عميل').slice(0,160);
  // A permission change while resolving the display name must not disclose an old preview.
  const latest=await store.getDevice(device.binding_id);
  if(!await canDeliver(latest,row))throw fault('ANDROID_PUSH_FORBIDDEN',403);
  return {eventId,sessionId:row.session_id,channel:row.channel,messageId:row.message_mid,
   customerName,preview:previewBody(message),messageKind:message.message_kind||'text',timestamp:message.timestamp||row.created_at};
 }
 async function acceptedEvents(header,before){
  if(before&&!UUID.test(before))throw fault('INVALID_NOTIFICATION_CURSOR');
  const device=await authenticateDevice(header);await currentUser({username:device.owner_name});
  const rows=await store.acceptedEvents(device.binding_id,before),page=rows.slice(0,100),events=[];
  for(const row of page)if(await canDeliver(device,row))events.push(row.event_id);
  return {events,nextCursor:rows.length>100?page.at(-1).event_id:null};
 }
 async function openNotification(header,eventId){
  if(!UUID.test(eventId))throw fault('NOTIFICATION_NOT_FOUND',404);
  const device=await authenticateDevice(header),row=await store.preview(eventId,device.binding_id);
  if(!row||!liveMessage(row))throw fault('NOTIFICATION_NOT_FOUND',404);
  const access=await getAccess(row.session_id),latest=await store.getDevice(device.binding_id);
  const user=await currentUser({username:latest?.owner_name});
  if(!usable(latest)||!canAccess(user,access))throw fault('ANDROID_PUSH_FORBIDDEN',403);
  // Delivery TTL must not break tapping a notification already shown yesterday.
  // This resolver returns routing only, never an expired preview or a new notification.
  return {eventId,sessionId:row.session_id};
 }
 return {register,revoke,preview,canDeliver,installationState,acceptedEvents,openNotification,cancelRegistration:(identity,id,body)=>register(identity,id,body,true)};
}
function registerAndroidPushRoutes(app,{requireAuth,service}){
 const noStore=(req,res,next)=>{res.set('Cache-Control','no-store');next();};
 const bearer=(req,res,next)=>{if(typeof req.headers.authorization!=='string'||!req.headers.authorization.startsWith('Bearer '))return res.status(401).json({error:'UNAUTHORIZED'});next();};
 const handle=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){const code=e.status&&/^ANDROID_PUSH_|^INVALID_|^SESSION_EXPIRED$|^DEVICE_SESSION_EXPIRED$|^NOTIFICATION_NOT_FOUND$|^DEVICE_CONFLICT$|^DEVICE_REVISION_CONFLICT$/.test(e.code||'')?e.code:'ANDROID_PUSH_UNAVAILABLE';res.status(code===e.code?e.status:503).json({error:code});}};
 app.put('/api/android-push/devices/:installationId',noStore,bearer,requireAuth,handle(async(req,res)=>res.json(await service.register(req.user,req.params.installationId,req.body))));
 app.post('/api/android-push/devices/:installationId/state',noStore,bearer,requireAuth,handle(async(req,res)=>res.json(await service.installationState(req.user,req.params.installationId,req.body))));
 app.post('/api/android-push/devices/:installationId/cancel',noStore,bearer,requireAuth,handle(async(req,res)=>{await service.cancelRegistration(req.user,req.params.installationId,req.body);res.status(204).end();}));
 app.post('/api/android-push/device/revoke',noStore,handle(async(req,res)=>{await service.revoke(req.headers.authorization);res.status(204).end();}));
 app.get('/api/android-push/notifications',noStore,handle(async(req,res)=>res.json(await service.acceptedEvents(req.headers.authorization,req.query.before))));
 app.get('/api/android-push/notifications/:eventId/open',noStore,handle(async(req,res)=>res.json(await service.openNotification(req.headers.authorization,req.params.eventId))));
 app.get('/api/android-push/notifications/:eventId',noStore,handle(async(req,res)=>res.json(await service.preview(req.headers.authorization,req.params.eventId))));
}
module.exports={fault,hash,secretHash,sameHash,encryptToken,decryptToken,liveMessage,previewBody,createAndroidPushService,registerAndroidPushRoutes};
