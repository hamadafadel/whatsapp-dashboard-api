'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('server preserves ALL existing channel, media, SSE and FCM code outside explicit campaign hooks',()=>{
 const root=path.resolve(__dirname,'..');
 let current=fs.readFileSync(path.join(root,'server.js'),'utf8').replace(/\r\n/g,'\n');
 // Pin the reviewed pre-campaign release so committing this change does not move the baseline.
 const baseline=execFileSync('git',['show','64dbfd3f1c62b3fb3b87f5e34f9f808a901f2fd2:server.js'],{cwd:root,encoding:'utf8'}).replace(/\r\n/g,'\n');
 current=current.replace("const {Campaigns,registerCampaigns} = require('./whatsapp-campaigns');\n",'')
 .replace("const {StatusInbox}=require('./whatsapp-template-status-inbox');\n",'')
 .replace("        WHERE NOT (COALESCE(message->>'type','')='agent' AND COALESCE(message->>'campaign_bulk','false')='true')\n",'')
 .replace("// Only the new admin campaign routes need larger recipient snapshots.\n// Leave the limits/raw-body behavior of every existing route unchanged.\napp.use('/api/whatsapp/campaigns', requireAuth, requireAdmin, express.json({limit:'8mb'}));\n",'')
 .replace("    if(row.payload?.dynamicTemplate){\n      await whatsappCampaigns.beforeDispatch(row);\n      return dynamicWhatsappTemplates.dispatch(row);\n    }","    if(row.payload?.dynamicTemplate)return dynamicWhatsappTemplates.dispatch(row);")
 .replace("const whatsappCampaigns=new Campaigns({pool,catalog:whatsappTemplateCatalog,dynamic:dynamicWhatsappTemplates,\n  queueStore:durableSendQueue.store,queue:durableSendQueue,account:findDashboardAccountByUsername,\n  canAccess:(user,sid)=>canRequestAccessConversation({user},sid)});\nregisterCampaigns(app,{service:whatsappCampaigns,requireAuth,requireAdmin,multer});\n",'')
 .replace('const whatsappStatusInbox=new StatusInbox({pool});\n','')
 .replace('whatsappCampaigns.start();\n','').replace('whatsappStatusInbox.start();\n','');
 assert.equal(current,baseline);
});
