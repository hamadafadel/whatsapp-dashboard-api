'use strict';
const labels={pending:'بانتظار الطابور',queued:'في الطابور',sending:'جارٍ الإرسال',sent:'قبلته Meta — دون تأكيد تسليم',delivered:'تم التسليم',read:'تمت القراءة',failed:'فشل',unknown:'نتيجة غير مؤكدة',excluded:'مستبعد'};
function enrich(r,campaign={}){
  let status=r.queue_state||r.state||'pending',reason=r.queue_reason||r.reason||null;
  if(status==='cancelled'||(campaign.state==='cancelled'&&status==='pending')){status='excluded';reason=reason||'CAMPAIGN_CANCELLED';}
  if(['read','delivered','failed','sent'].includes(r.delivery_status))status=r.delivery_status;
  const statusAt=r.delivery_status?r.delivery_at:r.queue_updated_at||r.updated_at||null;
  return {...r,status,status_at:statusAt,failure_reason:status==='failed'?(r.delivery_error_code!=null?`META_ERROR_${r.delivery_error_code}`:reason||'SEND_FAILED'):reason};
}
function summarize(rows){
  const s={total:rows.length,sent:0,remaining:0,excluded:0,failed:0,unknown:0,delivered:0,read:0,processed:0,progress:0};
  for(const r of rows){
    const status=r.status||enrich(r).status;
    if(['pending','queued','sending'].includes(status))s.remaining++;else s.processed++;
    if(['sent','delivered','read'].includes(status))s.sent++;
    if(['delivered','read'].includes(status))s.delivered++;
    if(status==='read')s.read++;
    if(['excluded','failed','unknown'].includes(status))s[status]++;
  }s.progress=s.total?Math.round(s.processed*100/s.total):0;return s;
}
const xml=s=>String(s??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function xlsxReport(detail){
  // A data-only OOXML writer used by the app, not an Excel/CSV formula evaluator.
  const {zipSync,strToU8}=require('fflate'),c=detail.campaign;
  const data=[['الحملة',c.title],['تاريخ الإنشاء (UTC)',new Date(c.created_at)],['القالب',c.template.name,'اللغة',c.template.language],['ملاحظة','قبول Meta لا يثبت التسليم أو القراءة. الحالات من السجل وقت التصدير.'],[],['العميل','رقم واتساب','الحالة','توقيت الحالة (UTC)','سبب / كود الخطأ','MID','مصادر الاختيار']];
  for(const r of detail.recipients)data.push([r.name,r.phone,labels[r.status]||r.status,r.status_at?new Date(r.status_at):'',r.failure_reason||'',r.confirmed_mid||r.message_id||'',(r.sources||[]).join('، ')]);
  const col=n=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
  const sheetRows=data.map((row,i)=>`<row r="${i+1}" ht="${i===3?42:i===5?30:i>=6?Math.max(30,Math.min(140,Math.ceil(Math.max(...row.map(v=>String(v??'').length))/30)*15+8)):26}" customHeight="1">${row.map((v,j)=>{
    const ref=col(j)+(i+1),style=i===5?1:v instanceof Date?2:0;
    if(v instanceof Date&&!Number.isNaN(v.getTime()))return `<c r="${ref}" s="2"><v>${v.getTime()/86400000+25569}</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const files={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="نتائج الحملة" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF54105B"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf fontId="0" fillId="0" borderId="0" numFmtId="0" xfId="0"><alignment vertical="top" wrapText="1" readingOrder="2"/></xf><xf fontId="1" fillId="2" borderId="0" numFmtId="0" xfId="0" applyFill="1" applyFont="1"><alignment vertical="center" readingOrder="2"/></xf><xf fontId="0" fillId="0" borderId="0" numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    'xl/worksheets/sheet1.xml':`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G${data.length}"/><sheetViews><sheetView workbookViewId="0" rightToLeft="1" showGridLines="0"><pane ySplit="6" topLeftCell="A7" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="20" customWidth="1"/><col min="3" max="3" width="34" customWidth="1"/><col min="4" max="4" width="24" customWidth="1"/><col min="5" max="7" width="38" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A6:G${Math.max(6,data.length)}"/><mergeCells count="1"><mergeCell ref="B4:G4"/></mergeCells></worksheet>`
  };return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p,s])=>[p,strToU8(s)]))));
}
module.exports={enrich,summarize,xlsxReport,labels};
