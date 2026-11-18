'use strict';
const idOf = reply => {
  const value = reply?.external_message_id || reply?.channel_message_id || reply?.mid || reply?.wa_message_id;
  return typeof value === 'string' && value.length <= 512 && !/\s/.test(value) ? value : '';
};
const keysOf = message => {
  const keys = [...new Set([
  message?.external_message_id, message?.channel_message_id, message?.wa_message_id,
  message?.message_id, message?.raw_message?.message?.mid, message?.raw_message?.id
  ].filter(value => typeof value === 'string' && value))];
  // Legacy rows with conflicting identity aliases cannot establish an original safely.
  return keys.length === 1 ? keys : [];
};
const messengerRow = row => !row.message?.channel || row.message.channel === 'messenger';
const safeUrl = value => {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
};

async function hydrateMessengerReplies(pool, sessionId, rows) {
  if (!String(sessionId).startsWith('fb:')) return rows;
  const references = [...new Set(rows.filter(messengerRow).map(row => idOf(row.message?.reply_to)).filter(Boolean))];
  if (!references.length) return rows;
  let targets = [];
  try {
    targets = (await pool.query(`
      SELECT id, session_id, message FROM chat_memory
      WHERE session_id = $1
        AND COALESCE(message->>'channel', 'messenger') = 'messenger'
        AND (message->>'external_message_id' = ANY($2::text[])
          OR message->>'channel_message_id' = ANY($2::text[])
          OR message->>'wa_message_id' = ANY($2::text[])
          OR message->>'message_id' = ANY($2::text[])
          OR message#>>'{raw_message,message,mid}' = ANY($2::text[])
          OR message#>>'{raw_message,id}' = ANY($2::text[]))
    `, [sessionId, references])).rows;
  } catch (_) {
    // Preview failure must not prevent reading the incoming messages.
    console.error('Messenger reply preview lookup unavailable');
  }
  const byMid = new Map();
  for (const row of targets) {
    if (row.session_id !== sessionId || !messengerRow(row)) continue;
    for (const mid of keysOf(row.message)) {
      if (!byMid.has(mid)) byMid.set(mid, new Map());
      byMid.get(mid).set(String(row.id), row);
    }
  }
  return rows.map(row => {
    if (!messengerRow(row)) return row;
    const mid = idOf(row.message?.reply_to);
    if (!mid) return row;
    const candidates = byMid.get(mid);
    const target = candidates?.size === 1 ? [...candidates.values()][0] : null;
    const original = target?.message;
    let preview = { external_message_id: mid, wa_message_id: mid, type: 'unknown',
      message_kind: 'unknown', content: 'الرسالة الأصلية غير متاحة', unresolved: true };
    if (target && String(target.id) !== String(row.id) && !original.deleted && !original.is_deleted) {
      const a = Array.isArray(original.attachments) ? original.attachments[0] : null;
      const kind = original.message_kind || a?.type || 'text';
      const media = safeUrl(original.media_url || a?.url || a?.payload?.url || a?.image_data?.url || a?.video_data?.url);
      preview = { external_message_id: mid, wa_message_id: mid, type: original.type || 'unknown',
        message_kind: kind, media_url: media,
        thumbnail_url: safeUrl(original.thumbnail_url || a?.thumbnail_url || a?.video_data?.preview_url),
        content: original.content || ({ image:'📷 صورة', video:'🎥 فيديو', audio:'🎙️ رسالة صوتية', file:'📄 ملف', document:'📄 ملف' }[kind] || 'رسالة'),
        unresolved: false };
    }
    return { ...row, message: { ...row.message, reply_to: preview } };
  });
}
module.exports = { hydrateMessengerReplies };
