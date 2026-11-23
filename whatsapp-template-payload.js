'use strict';
// Pure compiler. The n8n generator embeds this SAME function, not a second implementation.
function templateTools() {
  const fail=code=>{throw Object.assign(new Error(code),{code,status:422,definitive:true});};
  const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
  function names(text){return [...new Set([...String(text||'').matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*|\d+)\s*\}\}/g)].map(m=>m[1]))].sort((a,b)=>/^\d+$/.test(a)&&/^\d+$/.test(b)?Number(a)-Number(b):0);}
  function plan(t){
    if(t?.status!=='APPROVED'||!/^\d+$/.test(t.id||'')||!Array.isArray(t.components))fail('TEMPLATE_NOT_APPROVED');
    const fields=[],unsupported=[];
    const add=(key,label,type='text',required=true)=>fields.push({key,label,type,required});
    function vars(c,path,field){
      const ns=names(c[field]);
      if(ns.some(n=>/^\d+$/.test(n))&&ns.some((n,i)=>n!==String(i+1)))unsupported.push('NON_CONTIGUOUS_PARAMETERS');
      for(const n of ns)add(`${path}.${field}:${n}`,`${c.type} — {{${n}}}`);
      return ns;
    }
    t.components.forEach((c,i)=>{
      const p=`components[${i}]`;
      if(c.type==='BODY'||(c.type==='HEADER'&&(!c.format||c.format==='TEXT')))vars(c,p,'text');
      else if(c.type==='HEADER'&&['IMAGE','VIDEO','DOCUMENT'].includes(c.format))add(`${p}.media`,`${c.format} — Media ID أو رابط HTTPS`,'media');
      else if(c.type==='HEADER'&&c.format==='LOCATION')for(const k of ['latitude','longitude','name','address'])add(`${p}.${k}`,`LOCATION — ${k}`);
      else if(c.type==='FOOTER'){if(names(c.text).length)unsupported.push('DYNAMIC_FOOTER');}
      else if(c.type==='BUTTONS') (c.buttons||[]).forEach((b,j)=>{
        const bp=`${p}.buttons[${j}]`;
        if(b.type==='URL'){
          const ns=vars(b,bp,'url');
          if(ns.length>1||(ns.length&&!/\{\{\s*(?:\d+|[a-zA-Z_]\w*)\s*\}\}$/.test(b.url)))unsupported.push('URL_PARAMETER_POSITION');
        }else if(b.type==='QUICK_REPLY')add(`${bp}.payload`,`${b.text} — payload`,'payload',false);
        else if(b.type==='FLOW'){
          add(`${bp}.flow_token`,`${b.text} — Flow token`,'text',false);
          add(`${bp}.flow_action_data`,`${b.text} — Flow data (JSON)`,'json',false);
        }else if(b.type==='COPY_CODE')add(`${bp}.coupon_code`,`${b.text} — coupon code`);
        else if(!['PHONE_NUMBER','VOICE_CALL'].includes(b.type))unsupported.push(`BUTTON_${b.type}`);
      });
      else unsupported.push(`COMPONENT_${c.type}_${c.format||''}`);
    });
    if(fields.length>100)fail('TOO_MANY_TEMPLATE_FIELDS');
    return {fields,unsupported:[...new Set(unsupported)],supported:unsupported.length===0};
  }
  function compile(t,values={}){
    const spec=plan(t);if(!spec.supported)fail('UNSUPPORTED_TEMPLATE_COMPONENT');
    if(!object(values)||Object.keys(values).some(k=>!spec.fields.some(f=>f.key===k)))fail('UNEXPECTED_TEMPLATE_PARAMETER');
    const clean={};
    for(const f of spec.fields){
      const v=values[f.key];
      if(v===undefined||v===''){if(f.required)fail('MISSING_TEMPLATE_PARAMETER');continue;}
      if(typeof v!=='string'||v.length>4096||/[\r\n\t]| {5}/.test(v)||!v.trim())fail('INVALID_TEMPLATE_PARAMETER');
      clean[f.key]=v;
    }
    function textParams(c,p,field='text',named=true){return names(c[field]).map(n=>{
      const item={type:'text',text:clean[`${p}.${field}:${n}`]};
      if(named&&t.parameterFormat==='NAMED')item.parameter_name=n;
      return item;
    });}
    const components=[];
    t.components.forEach((c,i)=>{
      const p=`components[${i}]`;
      if(c.type==='BODY'||(c.type==='HEADER'&&(!c.format||c.format==='TEXT'))){
        const parameters=textParams(c,p);if(parameters.length)components.push({type:c.type.toLowerCase(),parameters});
      }else if(c.type==='HEADER'){
        if(c.format==='LOCATION'){
          const latitude=Number(clean[`${p}.latitude`]),longitude=Number(clean[`${p}.longitude`]);
          if(!Number.isFinite(latitude)||latitude < -90||latitude>90||!Number.isFinite(longitude)||longitude < -180||longitude>180)fail('INVALID_LOCATION');
          components.push({type:'header',parameters:[{type:'location',location:{latitude,longitude,name:clean[`${p}.name`],address:clean[`${p}.address`]}}]});
        }else{
          const type=c.format.toLowerCase(),v=clean[`${p}.media`];let media;
          if(/^\d{1,100}$/.test(v))media={id:v};else{
            // No Node imports or URL global: identical validation in n8n's Code sandbox.
            // Domain HTTPS only (default/443 port); opaque Meta media IDs remain preferred.
            const m=/^https:\/\/([a-zA-Z0-9.-]+)(?::443)?([/?][^\s#\\]*)?$/.exec(v);
            if(!m||!m[1].includes('.')||/^[\d.]+$/.test(m[1])||/(?:^|\.)(?:localhost|local|internal)$/i.test(m[1])||m[1].split('.').some(label=>!label||label.length>63||!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)))fail('INVALID_MEDIA_REFERENCE');
            media={link:v};
          }
          components.push({type:'header',parameters:[{type,[type]:media}]});
        }
      }else if(c.type==='BUTTONS')(c.buttons||[]).forEach((b,j)=>{
        const bp=`${p}.buttons[${j}]`;let parameters;
        if(b.type==='URL'){parameters=textParams(b,bp,'url',false);if(!parameters.length)return;}
        else if(b.type==='QUICK_REPLY'){
          const payload=clean[`${bp}.payload`];if(!payload)return;if(payload.length>128)fail('INVALID_BUTTON_PAYLOAD');
          parameters=[{type:'payload',payload}];
        }else if(b.type==='COPY_CODE'){
          const coupon_code=clean[`${bp}.coupon_code`];if(coupon_code.length>15)fail('INVALID_COUPON_CODE');parameters=[{type:'coupon_code',coupon_code}];
        }else if(b.type==='FLOW'){
          const action={flow_token:clean[`${bp}.flow_token`]||'unused'};
          if(action.flow_token.length>128)fail('INVALID_FLOW_TOKEN');
          if(clean[`${bp}.flow_action_data`]){
            let v;try{v=JSON.parse(clean[`${bp}.flow_action_data`]);}catch{fail('INVALID_FLOW_DATA');}
            if(!object(v)||JSON.stringify(v).length>4096||JSON.stringify(v).includes('__proto__'))fail('INVALID_FLOW_DATA');action.flow_action_data=v;
          }
          parameters=[{type:'action',action}];
        }else return;
        components.push({type:'button',sub_type:b.type.toLowerCase(),index:String(j),parameters});
      });
    });
    return {name:t.name,language:{code:t.language},...(components.length?{components}:{})};
  }
  function recipient(sessionId){
    if(typeof sessionId!=='string')fail('WHATSAPP_CONVERSATION_REQUIRED');
    if(/^EG\.[A-Za-z0-9._-]{3,180}$/.test(sessionId))return {recipient_type:'individual',recipient:sessionId};
    if(!/^[1-9]\d{6,14}$/.test(sessionId))fail('WHATSAPP_CONVERSATION_REQUIRED');
    return {recipient_type:'individual',to:sessionId};
  }
  return {plan,compile,recipient};
}
module.exports={templateTools};
