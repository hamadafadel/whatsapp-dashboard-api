'use strict';
const {parsePhoneNumberFromString}=require('libphonenumber-js/max');
const {fault}=require('./send-queue');
function phone(value,country){
  if(typeof value!=='string'||value.length>60||/^(fb:|ig:|EG\.)/i.test(value))throw fault('INVALID_WHATSAPP_NUMBER',422);
  let s=value.trim().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776));
  if(!/^[+\d\s().-]+$/.test(s))throw fault('INVALID_WHATSAPP_NUMBER',422);
  s=s.replace(/[\s().-]/g,'');if(s.startsWith('00'))s='+'+s.slice(2);
  // Bare international numbers are accepted; local numbers require an explicit country.
  if(!s.startsWith('+')&&!s.startsWith('0'))s='+'+s;
  const p=parsePhoneNumberFromString(s,{defaultCountry:country||undefined,extract:false});
  if(!p?.isValid()||p.ext)throw fault('INVALID_WHATSAPP_NUMBER',422);
  return p.number.slice(1);
}
function csv(text){
  const rows=[];let row=[],cell='',quoted=false;
  text=text.replace(/^\uFEFF/,'');const sep=text.split(/\r?\n/,1)[0].includes('\t')?'\t':text.split(/\r?\n/,1)[0].includes(';')?';':',';
  const push=()=>{row.push(cell);cell='';if(row.length>100)throw fault('IMPORT_TOO_MANY_COLUMNS',422);};
  for(let i=0;i<text.length;i++){
    const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(!cell||quoted)quoted=!quoted;else throw fault('INVALID_CSV',422);}
    else if(!quoted&&c===sep)push();else if(!quoted&&(c==='\n'||c==='\r')){if(c==='\r'&&text[i+1]==='\n')i++;push();if(row.some(Boolean))rows.push(row);row=[];if(rows.length>10001)throw fault('IMPORT_TOO_MANY_ROWS',422);}
    else cell+=c;if(cell.length>4096)throw fault('IMPORT_CELL_TOO_LONG',422);
  }
  if(quoted)throw fault('INVALID_CSV',422);push();if(row.some(Boolean))rows.push(row);return rows;
}
function guardZip(b){
  // Inspect central directory before decompression. Reject ZIP64, encryption and bombs.
  let end=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw fault('INVALID_XLSX',422);
  const n=b.readUInt16LE(end+10);let at=b.readUInt32LE(end+16),total=0;
  if(n>1500||n===65535)throw fault('IMPORT_ARCHIVE_LIMIT',422);
  for(let i=0;i<n;i++){
    if(at+46>b.length||b.readUInt32LE(at)!==0x02014b50)throw fault('INVALID_XLSX',422);
    const flags=b.readUInt16LE(at+8),method=b.readUInt16LE(at+10),compressedSize=b.readUInt32LE(at+20),size=b.readUInt32LE(at+24),len=b.readUInt16LE(at+28),extra=b.readUInt16LE(at+30),comment=b.readUInt16LE(at+32),local=b.readUInt32LE(at+42);
    total+=size;if(flags&1||size===0xffffffff||total>16*1024*1024)throw fault('IMPORT_ARCHIVE_LIMIT',422);
    const name=b.subarray(at+46,at+46+len).toString();if(/vbaProject|externalLinks/i.test(name))throw fault('IMPORT_ACTIVE_CONTENT',422);
    if(local+30>b.length||b.readUInt32LE(local)!==0x04034b50||![0,8].includes(method))throw fault('INVALID_XLSX',422);
    const start=local+30+b.readUInt16LE(local+26)+b.readUInt16LE(local+28);
    if(start+compressedSize>b.length)throw fault('INVALID_XLSX',422);
    // Do not trust the declared ZIP size: cap actual decompression as well.
    let actual;try{actual=method===0?b.subarray(start,start+compressedSize):require('node:zlib').inflateRawSync(b.subarray(start,start+compressedSize),{maxOutputLength:Math.min(size+1,16*1024*1024)});}catch{throw fault('IMPORT_ARCHIVE_LIMIT',422);}
    if(actual.length!==size)throw fault('IMPORT_ARCHIVE_SIZE_MISMATCH',422);
    at+=46+len+extra+comment;
  }
}
async function parseFile(buffer,filename){
  if(!Buffer.isBuffer(buffer)||buffer.length>2*1024*1024)throw fault('IMPORT_SIZE_LIMIT',422);
  let data;
  if(/\.csv$/i.test(filename))data=csv(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
  else if(/\.xlsx$/i.test(filename)){
    guardZip(buffer);const {readSheet}=require('read-excel-file/node');data=await readSheet(buffer,{sheet:1});
  }else throw fault('USE_XLSX_OR_UTF8_CSV',422);
  if(!data?.length||data.length>10001||data.some(r=>r.length>100))throw fault('IMPORT_DIMENSIONS',422);
  const headers=data[0].map(x=>String(x??'').trim());
  if(!headers.length||headers.some(x=>!x||x.length>120||['__proto__','constructor','prototype'].includes(x))||new Set(headers).size!==headers.length)throw fault('INVALID_IMPORT_HEADERS',422);
  const rows=data.slice(1).filter(r=>r.some(x=>x!=null&&x!=='' )).map(r=>Object.fromEntries(headers.map((h,i)=>{
    const value=r[i];if(value!=null&&!['number','string','boolean'].includes(typeof value))throw fault('IMPORT_TEXT_CELLS_ONLY',422);
    const s=String(value??'');if(s.length>4096||/^[=]/.test(s))throw fault('IMPORT_FORMULAS_NOT_SUPPORTED',422);return [h,s];
  })));
  return {headers,rows,total:rows.length};
}
module.exports={phone,csv,guardZip,parseFile};
