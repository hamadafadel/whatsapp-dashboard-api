const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const app = express();
// Temporary, opt-in Messenger-only diagnostics. Never inspect or log identities,
// headers, URLs, payload content, signatures, or raw error messages.
const MESSENGER_WEBHOOK_DIAGNOSTICS = process.env.MESSENGER_WEBHOOK_DIAGNOSTICS === 'true';
const messengerDiagnosticContext = Symbol('messengerWebhookDiagnostics');
function logMessengerWebhookDiagnostic(req, stage, fields = {}) {
  const context = req[messengerDiagnosticContext];
  if (!context) return;
  try {
    const record = { traceId: context.traceId, stage, elapsedMs: Math.max(0, Date.now() - context.startedAt) };
    for (const key of ['entry', 'messaging', 'standby', 'changes', 'message', 'is_echo', 'read', 'eventIndex', 'eventCount']) {
      if (Number.isSafeInteger(fields[key]) && fields[key] >= 0) record[key] = fields[key];
    }
    if (Number.isInteger(fields.httpStatus) && fields.httpStatus >= 100 && fields.httpStatus <= 599) record.httpStatus = fields.httpStatus;
    for (const key of ['signatureVerified', 'hasEcho', 'isEcho']) {
      if (typeof fields[key] === 'boolean') record[key] = fields[key];
    }
    if (fields.object === 'page' || fields.object === 'other') record.object = fields.object;
    if (['success', 'failed', 'skipped', 'finished', 'closed', 'accepted', 'rejected', 'no_events', 'not_configured'].includes(fields.outcome)) record.outcome = fields.outcome;
    if (['invalid_json', 'too_large', 'aborted', 'unsupported_encoding', 'other', 'network_error'].includes(fields.errorKind)) record.errorKind = fields.errorKind;
    if (fields.payloadTrust === 'verified' || fields.payloadTrust === 'unverified') record.payloadTrust = fields.payloadTrust;
    console.log('[MESSENGER_DIAGNOSTIC]', JSON.stringify(record));
  } catch (_) {
    // Diagnostics must never change request handling, including if logging fails.
  }
}
function logMessengerJsonParsing(req, err) {
  const kinds = {
    'entity.parse.failed': 'invalid_json',
    'entity.too.large': 'too_large',
    'request.aborted': 'aborted',
    'encoding.unsupported': 'unsupported_encoding',
    'charset.unsupported': 'unsupported_encoding'
  };
  logMessengerWebhookDiagnostic(req, 'parsing', {
    outcome: err ? 'failed' : Buffer.isBuffer(req.rawBody) ? 'success' : 'skipped',
    ...(err ? { errorKind: kinds[err.type] || 'other', httpStatus: err.status || err.statusCode } : {})
  });
}
app.use((req, res, next) => {
  if (MESSENGER_WEBHOOK_DIAGNOSTICS && req.method === 'POST' && /^\/api\/webhooks\/messenger\/?$/i.test(req.path)) {
    try {
      req[messengerDiagnosticContext] = { traceId: crypto.randomUUID(), startedAt: Date.now() };
      logMessengerWebhookDiagnostic(req, 'received');
      res.once('finish', () => logMessengerWebhookDiagnostic(req, 'response', { outcome: 'finished', httpStatus: res.statusCode }));
      res.once('close', () => {
        if (!res.writableFinished) logMessengerWebhookDiagnostic(req, 'response', { outcome: 'closed', httpStatus: res.statusCode });
      });
    } catch (_) {
      // Failure to initialize diagnostics must not block the request.
    }
  }
  next();
});
// Separate preparation-only OAuth routes; existing channel routes are unchanged.
// BEGIN INSTAGRAM INLINE OAUTH
function createInstagramOAuthHelpers() {
  'use strict';
const CALLBACK = '/auth/instagram/callback';
const COMPLETE = CALLBACK + '/complete';
const COOKIE = '__Host-ig-oauth';
const TTL = 5 * 60 * 1000;
function config(env) {
  const redirect = new URL(env.INSTAGRAM_OAUTH_REDIRECT_URI);
  const frontend = new URL(env.INSTAGRAM_OAUTH_FRONTEND_ORIGIN);
  if (redirect.protocol !== 'https:' || redirect.pathname !== CALLBACK || redirect.search || redirect.hash || redirect.username || redirect.password ||
      frontend.protocol !== 'https:' || frontend.origin !== env.INSTAGRAM_OAUTH_FRONTEND_ORIGIN ||
      !/^\d+$/.test(env.META_APP_ID || '') || !/^\d+$/.test(env.INSTAGRAM_FACEBOOK_LOGIN_CONFIG_ID || '') || !/^v\d+\.\d+$/.test(env.INSTAGRAM_OAUTH_GRAPH_VERSION || '')) throw Error('OAuth configuration invalid');
  return { redirect: redirect.href, origin: redirect.origin, frontend: frontend.origin, appId: env.META_APP_ID, configId: env.INSTAGRAM_FACEBOOK_LOGIN_CONFIG_ID, version: env.INSTAGRAM_OAUTH_GRAPH_VERSION };
}
function createStore(now = Date.now) {
  const pending = new Map();
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  return {
    issue(username) {
      for (const [key, value] of pending) if (value.expires <= now()) pending.delete(key);
      if (pending.size >= 1000) throw Error('OAuth temporarily unavailable');
      const state = crypto.randomBytes(32).toString('base64url');
      const binding = crypto.randomBytes(32).toString('base64url');
      pending.set(state, { binding: digest(binding), username, expires: now() + TTL });
      return { state, binding };
    },
    consume(state, binding) {
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || typeof binding !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(binding)) return false;
      const entry = pending.get(state);
      if (!entry || entry.expires <= now() || !crypto.timingSafeEqual(Buffer.from(entry.binding), Buffer.from(digest(binding)))) return false;
      pending.delete(state);
      return true;
    }
  };
}
function classify(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid response');
  const allowed = ['state', 'code', 'access_token', 'error', 'error_reason', 'error_description', 'expires_in'];
  if (Object.keys(body).some(k => !allowed.includes(k)) || Object.values(body).some(v => typeof v !== 'string' || v.length > 16384)) throw Error('Invalid response');
  const hasCode = !!body.code, hasToken = !!body.access_token, hasError = !!(body.error || body.error_reason);
  if ([hasCode, hasToken, hasError].filter(Boolean).length !== 1) throw Error('Ambiguous response');
  if (hasError) return { status: body.error === 'access_denied' || body.error_reason === 'user_denied' ? 'cancelled' : 'provider_error', connected: false };
  // This preparation stage neither exchanges codes nor validates/stores tokens.
  return { status: 'authorization_received', responseType: hasCode ? 'code' : 'token', connected: false };
}
function bridgeScript() {
  return `(async()=>{
 const output=document.getElementById('result');
 let payload={};
 try{
  const query=new URLSearchParams(location.search),fragment=new URLSearchParams(location.hash.slice(1));
  history.replaceState(null,'',location.pathname);
  const allowed=['state','code','access_token','error','error_reason','error_description','expires_in'];
  for(const key of allowed){const a=query.getAll(key),b=fragment.getAll(key);if(a.length+b.length>1)throw Error();if(a.length||b.length)payload[key]=(a[0]??b[0]);}
  const response=await fetch('${COMPLETE}',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error'});
  const result=await response.json();
  if(!response.ok)throw Error();
  output.textContent=result.status==='cancelled'?'تم إلغاء التفويض.':result.status==='provider_error'?'تعذر إكمال التفويض لدى Meta.':'تم استلام نتيجة التفويض بأمان. لم يتم ربط الحساب أو حفظ توكن في هذه المرحلة.';
 }catch{output.textContent='تعذر التحقق من نتيجة التفويض. ابدأ محاولة جديدة من حساب Admin.';}
 finally{for(const key of Object.keys(payload))payload[key]='';payload={};}
})();`;
}
function registerInstagramOAuth(app, { requireAuth, requireAdmin, env = process.env, store = createStore() }) {
  const security = (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Opener-Policy': 'same-origin' }); next(); };
  const getConfig = res => { try { return config(env); } catch { res.status(503).json({ error: 'Instagram OAuth is not configured' }); return null; } };
  const cookie = (res, value, maxAge) => res.cookie(COOKIE, value, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge });
  // Mounted before global CORS. Only these OAuth endpoints get scoped CORS.
  app.options('/auth/instagram/start', security, (req, res) => {
    const c = getConfig(res); if (!c) return;
    if (![c.origin, c.frontend].includes(req.get('Origin'))) return res.sendStatus(403);
    res.set({ 'Access-Control-Allow-Origin': req.get('Origin'), 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', Vary: 'Origin' }); res.sendStatus(204);
  });
  app.post('/auth/instagram/start', security, (req, res, next) => {
    const c = getConfig(res); if (!c) return;
    if (![c.origin, c.frontend].includes(req.get('Origin'))) return res.sendStatus(403);
    res.set({ 'Access-Control-Allow-Origin': req.get('Origin'), 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });
    if (!/^Bearer \S+$/.test(req.headers.authorization || '')) return res.sendStatus(401);
    next();
  }, requireAuth, requireAdmin, (req, res) => {
    const c = getConfig(res); if (!c) return;
    try {
      const { state, binding } = store.issue(req.user.username);
      const url = new URL('https://www.facebook.com/' + c.version + '/dialog/oauth');
      url.search = new URLSearchParams({ client_id: c.appId, redirect_uri: c.redirect, config_id: c.configId, response_type: 'code', state }).toString();
      cookie(res, binding, TTL); res.json({ authorizationUrl: url.href, expiresIn: TTL / 1000 });
    } catch { res.status(429).json({ error: 'OAuth temporarily unavailable' }); }
  });
  app.get(CALLBACK, security, (req, res) => {
    const c = getConfig(res); if (!c) return;
    const nonce = crypto.randomBytes(18).toString('base64');
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    res.type('html').send(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>تفويض Instagram</title><p id="result">جاري التحقق من نتيجة التفويض…</p><script nonce="${nonce}">${bridgeScript()}</script></html>`);
  });
  app.post(COMPLETE, security, (req, res) => {
    const c = getConfig(res); if (!c) return;
    if (req.get('Origin') !== c.origin || !req.is('application/json')) return res.sendStatus(403);
    let body = req.body;
    try {
      const result = classify(body);
      const matches = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='));
      const binding = matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : '';
      if (!store.consume(body.state, binding)) return res.status(403).json({ error: 'Invalid or expired OAuth state' });
      cookie(res, '', 0); res.json(result);
    } catch { res.status(400).json({ error: 'Invalid OAuth response' }); }
    finally { if (body && typeof body === 'object') for (const key of Object.keys(body)) body[key] = ''; req.body = {}; body = null; }
  });
}
  return { registerInstagramOAuth, config, createStore, classify, bridgeScript };
}
// END INSTAGRAM INLINE OAUTH
const { registerInstagramOAuth } = createInstagramOAuthHelpers();
// JSON parsing for the callback completion is scoped here because OAuth routes
// precede global CORS. No raw-body/signature behavior of existing webhooks changes.
app.use('/auth/instagram/callback/complete', express.json({ limit: '24kb' }));
app.use('/auth/instagram/callback/complete', (err, req, res, next) => {
  // Never let JSON parser diagnostics reflect authorization material.
  if (!err) return next();
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.status(400).json({ error: 'Invalid OAuth response' });
});
registerInstagramOAuth(app, { requireAuth, requireAdmin });
app.use(cors());
const parseDashboardJson = express.json({
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
});
app.use((req, res, next) => {
  if (!req[messengerDiagnosticContext]) return parseDashboardJson(req, res, next);
  let continued = false;
  const parsed = (err) => {
    continued = true;
    logMessengerJsonParsing(req, err);
    next(err);
  };
  try {
    return parseDashboardJson(req, res, parsed);
  } catch (err) {
    if (continued) throw err;
    return parsed(err);
  }
});
// منع تخزين ملفات واجهة الداشبورد القديمة
app.use((req, res, next) => {
  const noCacheFiles = [
    "/",
    "/index.html",
    "/app.js",
    "/app.css",
    "/service-worker.js",
    "/manifest.json"
  ];

  const pathname = String(req.path || "");

  if (
    noCacheFiles.includes(pathname) ||
    pathname.endsWith("/app.js") ||
    pathname.endsWith("/app.css")
  ) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }

  next();
});

const uploadsDir = path.join(__dirname, 'uploads');
const thumbnailsDir = path.join(uploadsDir, 'thumbs');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(thumbnailsDir)) {
  fs.mkdirSync(thumbnailsDir, { recursive: true });
}

async function createImageThumbnail(filePath, fileName, isVideo = false) {
  const thumbnailName = `${path.parse(fileName).name}.jpg`;
  const thumbnailPath = path.join(thumbnailsDir, thumbnailName);

  async function extract(seekSeconds) {
    const args = ['-y'];

    if (seekSeconds) {
      args.push('-ss', String(seekSeconds));
    }

    args.push(
      '-i', filePath,
      '-vf', "scale='min(480,iw)':-2",
      '-frames:v', '1',
      '-q:v', '5',
      thumbnailPath
    );

    await execFileAsync('ffmpeg', args);
  }

  if (isVideo) {
    // أول فريم (وقت 0) غالبًا بيكون فريم أسود/فيد إن، فبنقفز ثانية جوه
    // الفيديو الأول؛ لو الفيديو أقصر من ثانية، بنرجع نجرب من غير seek
    try {
      await extract(1);
      return thumbnailName;
    } catch (err) {
      // fallthrough للمحاولة من غير seek
    }
  }

  await extract(0);
  return thumbnailName;
}

// بيضغط الفيديو لحد ما يبقى تحت حد واتساب (بيحسب البتريت المطلوب بناءً
// على مدة الفيديو، عشان الحجم النهائي يوصل تحت الحد المطلوب)
async function compressVideoForWhatsApp(filePath, originalFileName, targetBytes) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);

  const duration = parseFloat(stdout.trim()) || 0;

  if (!duration) {
    throw new Error('تعذر قراءة مدة الفيديو');
  }

  const AUDIO_BITRATE = 64000;
  const SAFETY_MARGIN = 0.95; // هامش أمان عشان حجم الـ container الفعلي غالبًا بيزيد شوية عن البتريت المحسوب
  const targetBits = targetBytes * 8 * SAFETY_MARGIN;
  const videoBitrate = Math.max(
    Math.floor(targetBits / duration) - AUDIO_BITRATE,
    150000
  );

  const parsedName = path.parse(originalFileName);
  const compressedFileName = `${parsedName.name}-compressed.mp4`;
  const compressedPath = path.join(uploadsDir, compressedFileName);

  await execFileAsync('ffmpeg', [
    '-y',
    '-i', filePath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', String(videoBitrate),
    '-maxrate', String(Math.floor(videoBitrate * 1.5)),
    '-bufsize', String(videoBitrate * 2),
    '-vf', "scale='min(1920,iw)':-2",
    '-c:a', 'aac',
    '-b:a', String(AUDIO_BITRATE),
    '-movflags', '+faststart',
    compressedPath
  ]);

  const stats = fs.statSync(compressedPath);

  return {
    path: compressedPath,
    filename: compressedFileName,
    size: stats.size
  };
}

// الملفات المرفوعة أسماؤها فريدة، لذلك يمكن تخزينها بأمان لمدة سنة.
app.use(
  '/uploads',
  express.static(uploadsDir, {
    etag: true,
    lastModified: true,
    maxAge: '365d',
    immutable: true,
    setHeaders(res, filePath) {
      res.setHeader(
        'Cache-Control',
        'public, max-age=31536000, immutable'
      );

      if (path.extname(filePath).toLowerCase() === '.mp3') {
        res.setHeader('Content-Type', 'audio/mpeg');
      }
    }
  })
);

app.use(
  express.static(__dirname, {
    etag: false,
    lastModified: false,
    maxAge: 0
  })
);
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
  const uniqueName =
    Date.now() + "-" + Math.round(Math.random() * 1e9);

  const originalExt = path.extname(file.originalname || "").toLowerCase();

  const mimeType = String(file.mimetype || "")
    .toLowerCase()
    .split(";")[0]
    .trim();

  const extensionByMime = {
    // Audio
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/amr": ".amr",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/webm": ".webm",

    // Images
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",

    // Videos
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/3gpp": ".3gp",
    "video/webm": ".webm",

    // Documents
    "application/pdf": ".pdf"
  };

  const ext =
    extensionByMime[mimeType] ||
    originalExt ||
    ".bin";

  cb(null, uniqueName + ext);
}
});

const upload = multer({ storage });
const uploadMemory = multer({ storage: multer.memoryStorage() });
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '123456';
const DASHBOARD_AGENT1_USERNAME =
  process.env.DASHBOARD_AGENT1_USERNAME || '';
const DASHBOARD_AGENT1_PASSWORD =
  process.env.DASHBOARD_AGENT1_PASSWORD || '';
const DASHBOARD_GALLERY_USERNAME =
  process.env.DASHBOARD_GALLERY_USERNAME || '';
const DASHBOARD_GALLERY_PASSWORD =
  process.env.DASHBOARD_GALLERY_PASSWORD || '';
const DASHBOARD_CONFIRMATION_USERNAME =
  process.env.DASHBOARD_CONFIRMATION_USERNAME || '';
const DASHBOARD_CONFIRMATION_PASSWORD =
  process.env.DASHBOARD_CONFIRMATION_PASSWORD || '';
const ORDER_CONFIRMATION_LINK_SECRET =
  process.env.ORDER_CONFIRMATION_LINK_SECRET || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
// Explicitly configure the secret of the Meta app subscribed to Instagram.
// No implicit fallback to another channel's app secret.
const INSTAGRAM_VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || '';
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || '';
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID || '';
// Enable only after the isolated SQL tests, migration and role grants are approved.
const INSTAGRAM_INGRESS_ENABLED = process.env.INSTAGRAM_INGRESS_ENABLED === 'true';
const N8N_MESSENGER_WEBHOOK_URL =
  process.env.N8N_MESSENGER_WEBHOOK_URL || '';
const N8N_FB_SEND_WEBHOOK_URL =
  process.env.N8N_FB_SEND_WEBHOOK_URL || '';

// فولدر جوجل درايف الرئيسي لمعرض الصور، وفولدر رفعيات content_team1 الخاص بيه
const GALLERY_ROOT_FOLDER_ID =
  process.env.GALLERY_ROOT_FOLDER_ID || '1YWEZuUiJfHsqHEjrHX-XV36inomkRoAc';

// الفولدر الفرعي المخصص لرفعيات content_team1 بس — لازم يتعمل يدويًا في
// درايف جوه الفولدر الرئيسي وتتحط الـ ID بتاعته هنا، عشان رفعياته تتحفظ
// في مكان ثابت ومعروف بدل ما ندور عليه أو ننشئه ديناميكيًا كل مرة
const GALLERY_UPLOAD_FOLDER_ID =
  process.env.GALLERY_UPLOAD_FOLDER_ID || GALLERY_ROOT_FOLDER_ID;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@almehrab.org';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID keys not set — push notifications are disabled.');
}

function getDashboardAccounts() {
  const accounts = [
    {
      username: DASHBOARD_USERNAME,
      password: DASHBOARD_PASSWORD,
      role: 'admin',
      displayName: 'Admin'
    }
  ];

  if (DASHBOARD_AGENT1_USERNAME && DASHBOARD_AGENT1_PASSWORD) {
    accounts.push({
      username: DASHBOARD_AGENT1_USERNAME,
      password: DASHBOARD_AGENT1_PASSWORD,
      role: 'agent',
      displayName: 'Agent1'
    });
  }

  if (DASHBOARD_GALLERY_USERNAME && DASHBOARD_GALLERY_PASSWORD) {
    accounts.push({
      username: DASHBOARD_GALLERY_USERNAME,
      password: DASHBOARD_GALLERY_PASSWORD,
      role: 'gallery',
      displayName: 'Content Team'
    });
  }

  if (
    DASHBOARD_CONFIRMATION_USERNAME &&
    DASHBOARD_CONFIRMATION_PASSWORD
  ) {
    accounts.push({
      username: DASHBOARD_CONFIRMATION_USERNAME,
      password: DASHBOARD_CONFIRMATION_PASSWORD,
      role: 'confirmation',
      displayName: 'Confirmation1'
    });
  }

  return accounts;
}

function findDashboardAccount(username, password) {
  return getDashboardAccounts().find(
    (account) =>
      account.username === username &&
      account.password === password
  ) || null;
}

function findDashboardAccountByUsername(username) {
  return getDashboardAccounts().find(
    (account) => account.username === String(username || '')
  ) || null;
}

function getConversationVisibilityUsers() {
  return getDashboardAccounts()
    .filter((account) => ['agent', 'confirmation'].includes(account.role))
    .map(({ username, role, displayName }) => ({ username, role, displayName }));
}
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';

  const token =
    authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : req.query.token || null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only' });
  }

  next();
}

function requireConfirmationAccess(req, res, next) {
  if (!['admin', 'confirmation'].includes(req.user?.role)) {
    return res.status(403).json({
      error: 'Order confirmation access only'
    });
  }

  next();
}

function normalizeOrderConfirmationPhone(value) {
  return String(value || '').trim().replace(/[\s()+-]/g, '');
}

function normalizeOrderConfirmationData(source = {}) {
  return {
    phone: normalizeOrderConfirmationPhone(source.phone),
    name: String(source.name || '').trim(),
    order: String(source.order || '').trim(),
    items: String(source.items || '').trim(),
    address: String(source.address || '').trim(),
    contact: String(source.contact || '').trim(),
    total: String(source.total || '').trim()
  };
}

function getOrderConfirmationCanonicalPayload(source = {}) {
  const data = normalizeOrderConfirmationData(source);
  return JSON.stringify([
    data.phone,
    data.name,
    data.order,
    data.items,
    data.address,
    data.contact,
    data.total
  ]);
}

function getOrderConfirmationPayloadDigest(source = {}) {
  return crypto
    .createHash('sha256')
    .update(getOrderConfirmationCanonicalPayload(source), 'utf8')
    .digest('hex');
}

function verifyOrderConfirmationLinkSignature(source = {}) {
  if (!ORDER_CONFIRMATION_LINK_SECRET) return false;

  const received = String(source.sig || '').trim().toLowerCase();
  const expected = crypto
    .createHmac('sha256', ORDER_CONFIRMATION_LINK_SECRET)
    .update(getOrderConfirmationCanonicalPayload(source), 'utf8')
    .digest('hex');

  return safeEqualText(received, expected);
}

function getTemporaryOrderConfirmationGrant(req) {
  const token = String(
    req.headers['x-order-confirmation-access'] ||
    req.query.orderConfirmationAccess ||
    ''
  );
  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function hasTemporaryOrderConfirmationAccess(req, sessionId) {
  if (req.user?.role !== 'confirmation') return false;
  const grant = getTemporaryOrderConfirmationGrant(req);
  return (
    grant?.scope === 'order_confirmation_session' &&
    grant?.username === req.user.username &&
    grant?.sessionId === String(sessionId || '')
  );
}

function canUseTemporaryOrderConfirmationAccess(req, sessionId, accessState) {
  return (
    hasTemporaryOrderConfirmationAccess(req, sessionId) &&
    !accessState.globallyHidden &&
    !accessState.hiddenForUsernames.has(req.user?.username)
  );
}

function requireGallery(req, res, next) {
  if (req.user?.role !== 'gallery' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Gallery access only' });
  }

  next();
}
app.get('/debug-files', (req, res) => {
  res.json({
    dir: __dirname,
    files: fs.readdirSync(__dirname)
  });
});

app.get('/mobile.html', (req, res) => {
  const filePath = path.join(__dirname, 'mobile.html');

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('mobile.html not found in container');
  }

  res.sendFile(filePath);
});

const clients = new Set();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// BEGIN INSTAGRAM INLINE CHANNEL
function createInstagramChannelHelpers() {
  'use strict';
// Pure validation shared by Dashboard API and the outbound n8n Code node.
// No HTTP, credentials, database access, or implicit channel fallback.
function prepareInstagramSendRequest(input, config) {
 const fail=(errorCode,httpStatus=400)=>{throw Object.assign(new Error(errorCode),{errorCode,httpStatus});};
 if(input.channel!=='instagram')fail('INVALID_CHANNEL');
 const account=String(config.accountId||'');
 const match=/^ig:(\d+):(\d+)$/.exec(String(input.sessionId||''));
 if(!match||!/^\d+$/.test(account)||match[1]!==account||match[2]===account)fail('INVALID_SESSION');
 const id=String(input.requestId||'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))fail('INVALID_REQUEST_ID');
 const kind=input.messageKind||'text';
 if(kind==='reaction'){
  const mid=input.messageId;
  if(typeof mid!=='string'||!mid||mid.length>2000||/[\s\x00-\x1f]/.test(mid)||/^\d+$/.test(mid)||/^(ig-|ig:|fb:|wamid[.:])/.test(mid))fail('INVALID_REACTION_TARGET');
  if(input.replyTo)fail('INVALID_REACTION_TARGET');
  if(typeof input.emoji!=='string'||input.emoji.length>64||/[\s\x00-\x1fA-Za-z]/.test(input.emoji))fail('INVALID_INSTAGRAM_REACTION',422);
  const emoji=['❤','♥','♥️'].includes(input.emoji)?'❤️':input.emoji;
  if(emoji!==''&&(!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Presentation}/u.test(emoji)||[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(emoji)].length!==1))fail('INVALID_INSTAGRAM_REACTION',422);
  return {requestId:id,sessionId:input.sessionId,customerId:match[2],reactionTarget:mid,reactionEmoji:emoji,prepared:{reply_to:null},
   sendPayload:{recipient:{id:match[2]},sender_action:emoji?'react':'unreact',payload:{message_id:mid,...(emoji?{reaction:emoji}:{})}}};
 }
 if(!['text','image','video','audio'].includes(kind))fail('UNSUPPORTED_KIND',422);
 let replyTo=null;
 if(input.replyTo!=null){
  const reply=input.replyTo;
  if(typeof reply!=='object'||Array.isArray(reply))fail('INVALID_REPLY_TARGET');
  const ids=[reply.external_message_id,reply.channel_message_id,reply.message_id,reply.wa_message_id].filter(v=>v!=null&&v!=='');
  const mid=ids[0];
  if(typeof mid!=='string'||!mid||mid.length>2000||/[\s\x00-\x1f]/.test(mid)||/^\d+$/.test(mid)||/^(ig-|ig:|fb:|wamid[.:])/.test(mid)||ids.some(v=>v!==mid))fail('INVALID_REPLY_TARGET');
  if(reply.sessionId&&reply.sessionId!==input.sessionId)fail('REPLY_TARGET_FORBIDDEN',403);
  replyTo={mid,external_message_id:mid,channel_message_id:mid,wa_message_id:mid};
 }
 if(input.caption!==undefined&&(typeof input.caption!=='string'||input.caption.length>1000))fail('INVALID_CAPTION');
 let message,mediaUrl='';
 if(kind==='text'){
  if(typeof input.message!=='string'||!input.message.trim()||input.message.length>1000)fail('INVALID_TEXT');
  message={text:input.message};
 }else{
  const origin=config.mediaOrigin||'https://wadashboardapi.almehrab.org';
  if(!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(origin))fail('INVALID_MEDIA_ORIGIN',503);
  if(typeof input.mediaUrl!=='string'||!input.mediaUrl.startsWith(origin+'/uploads/')||
     /[?#\\\s<>"']/.test(input.mediaUrl))fail('INVALID_MEDIA_URL');
  let path;try{path=decodeURIComponent(input.mediaUrl.slice(origin.length));}catch{fail('INVALID_MEDIA_URL');}
  if(/[\\?#%\x00-\x1f]/.test(path)||path.split('/').some(p=>p==='.'||p==='..'))fail('INVALID_MEDIA_URL');
  mediaUrl=input.mediaUrl;message={attachment:{type:kind,payload:{url:mediaUrl}}};
 }
 const prepared={type:'agent',channel:'instagram',message_kind:kind,
  content:kind==='text'?input.message:`[Instagram ${kind}]`,caption:kind==='text'?'':(input.caption||''),media_url:mediaUrl,
  attachments:kind==='text'?[]:[{type:kind,payload:{url:mediaUrl}}],
  agent_name:typeof input.agentName==='string'?input.agentName.slice(0,120):'',reply_to:replyTo};
 return {requestId:id,sessionId:input.sessionId,customerId:match[2],prepared,
  sendPayload:{recipient:{id:match[2]},messaging_type:'RESPONSE',message,...(replyTo?{reply_to:{mid:replyTo.mid}}:{})}};
}
function instagramError(message,status=503){return Object.assign(new Error(message),{status});}
function parseInstagramSession(value,account){const m=/^ig:(\d+):(\d+)$/.exec(String(value||''));if(!m||m[1]!==account||m[1]===m[2])throw instagramError('Invalid Instagram session',400);return {account:m[1],customer:m[2]};}
function createInstagramService({pool,env=process.env,fetchImpl=globalThis.fetch,now=Date.now}){
 const account=String(env.INSTAGRAM_ACCOUNT_ID||'');
 const query=async(sql,args)=>{if(!pool)throw instagramError('Instagram database is not configured');try{return await pool.query(sql,args);}catch{throw instagramError('Instagram storage is unavailable');}};
 function workflowUrl(value,path){let url;try{url=new URL(value);}catch{throw instagramError('Invalid Instagram workflow URL');}
  if(url.origin!=='https://n8n.almehrab.org'||url.pathname!==path||url.search||url.hash||url.username||url.password)throw instagramError('Invalid Instagram workflow URL');return url.href;}
 async function receive(envelope,eventCount){
  if(!env.N8N_INSTAGRAM_WORKER_WEBHOOK_URL||!env.INTERNAL_API_TOKEN)throw instagramError('Instagram receive workflow is not configured');
  const url=workflowUrl(env.N8N_INSTAGRAM_WORKER_WEBHOOK_URL,'/webhook/instagram-events');
  let response,data;try{response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':env.INTERNAL_API_TOKEN},
   body:JSON.stringify(envelope),redirect:'error',signal:AbortSignal.timeout(45000)});data=await response.json();}catch{throw instagramError('Instagram receive workflow did not confirm persistence');}
  if(!response.ok||data?.received!==true||data.eventCount!==eventCount||!Number.isInteger(data.persistedCount)||!Number.isInteger(data.ignoredCount)||data.persistedCount<0||data.ignoredCount<0||data.persistedCount+data.ignoredCount!==eventCount)
   throw instagramError('Instagram receive workflow did not confirm persistence');
  return {received:true,eventCount};
 }
 async function send(input){
  parseInstagramSession(input.sessionId,account);
  if(env.INSTAGRAM_OUTBOUND_ENABLED!=='true'||!env.N8N_IG_SEND_WEBHOOK_URL||!env.INTERNAL_API_TOKEN)throw instagramError('Instagram send workflow is not configured');
  const url=workflowUrl(env.N8N_IG_SEND_WEBHOOK_URL,'/webhook/dashboard-send-ig');
  const requestId=input.requestId||crypto.randomUUID();
  const body={channel:'instagram',sessionId:input.sessionId,requestId,message:input.message||'',messageKind:input.messageKind||'text',
   mediaUrl:input.mediaUrl||'',caption:input.caption||'',agentName:input.agentName||'',replyTo:input.replyTo||null,
   ...(input.messageKind==='reaction'?{messageId:input.messageId,emoji:input.emoji}:{})};
  try{const prepared=prepareInstagramSendRequest(body,{accountId:account,mediaOrigin:env.INSTAGRAM_MEDIA_ORIGIN});body.replyTo=prepared.prepared.reply_to;
   if(body.messageKind==='reaction')body.emoji=prepared.reactionEmoji;}
  catch(error){throw instagramError(error.errorCode||'Invalid Instagram send request',error.httpStatus||400);}
  if(body.replyTo||body.messageKind==='reaction'){
   const target=await query(`SELECT message FROM public.chat_memory WHERE session_id=$1
    AND message->>'channel'='instagram' AND message->>'message_kind' IS DISTINCT FROM 'reaction'
    AND COALESCE(message->>'is_deleted','false')<>'true'
    AND (message->>'external_message_id'=$2 OR message->>'channel_message_id'=$2)
    ORDER BY id LIMIT 1`,[body.sessionId,body.messageKind==='reaction'?body.messageId:body.replyTo.mid]);
   const original=target.rows[0]?.message;
   if(!original)throw instagramError('Instagram reply target does not belong to this conversation',403);
   if(body.replyTo)body.replyTo={...body.replyTo,content:original.content||'',type:original.type||'unknown',
    message_kind:original.message_kind||'text',media_url:original.media_url||''};
  }
  const context=await query(`SELECT max((message->>'timestamp')::timestamptz) AS last_user_message_at
   FROM public.chat_memory WHERE session_id=$1 AND message->>'channel'='instagram'
   AND message->>'type'='user' AND message->>'message_kind' IS DISTINCT FROM 'reaction'
   AND message->>'timestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T';`,[body.sessionId]);
  const last=new Date(context.rows[0]?.last_user_message_at||0).getTime();
  if(!last||now()-last>24*60*60*1000||last>now()+60000)throw instagramError('Instagram reply window is closed',403);
  let response,data;try{response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':env.INTERNAL_API_TOKEN},
   body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(45000)});data=await response.json();}
  catch{throw instagramError('Instagram workflow delivery is uncertain; check the conversation before resending',502);}
  const messages={META_REJECTED:'Meta rejected the Instagram message',DELIVERY_UNKNOWN:'Instagram delivery is uncertain; check the conversation before resending',
   CAPTION_FAILED:'Instagram attachment was sent but its caption failed; do not resend the attachment',SENT_NOT_FINALIZED:'Meta accepted the message but local saving failed; do not resend automatically',WINDOW_CLOSED:'Instagram reply window is closed',
   SENDING_DISABLED:'Instagram send workflow is disabled',STORAGE_UNAVAILABLE:'Instagram storage is unavailable'};
  if(body.messageKind==='reaction'&&data?.errorCode==='META_REJECTED')throw instagramError('Meta rejected the selected Instagram reaction; no local reaction update was confirmed',422);
  if(!response.ok||data?.success!==true)throw instagramError(messages[data?.errorCode]||'Instagram send workflow failed; do not resend automatically',
   data?.errorCode==='WINDOW_CLOSED'?403:['SENDING_DISABLED','STORAGE_UNAVAILABLE'].includes(data?.errorCode)?503:502);
  if(body.messageKind==='reaction'){
   if(data.messageKind!=='reaction'||data.message_id!==body.messageId||data.requestId!==requestId||
      data.emoji!==body.emoji||!(/^[1-9][0-9]*$/).test(String(data.storage_id||'')))throw instagramError('Instagram reaction persistence was not confirmed; do not retry automatically',502);
   return {success:true,channel:'instagram',messageKind:'reaction',message_id:data.message_id,emoji:body.emoji,displayEmoji:typeof data.displayEmoji==='string'?data.displayEmoji:body.emoji,requestId,storage_id:data.storage_id};
  }
  if(typeof data.message_id!=='string'||!data.message_id||data.requestId!==requestId||!(/^[1-9][0-9]*$/).test(String(data.storage_id||'')))
   throw instagramError('Instagram workflow returned an incomplete confirmation; do not resend automatically',502);
  return {success:true,channel:'instagram',message_id:data.message_id,requestId,storage_id:data.storage_id};
 }
 return {send,receive,async ready(){if(!pool)return false;await query('SELECT 1 FROM public.chat_memory LIMIT 0',[]);return true;}};
}
  return { createInstagramService, parseInstagramSession, prepareInstagramSendRequest };
}
// END INSTAGRAM INLINE CHANNEL
const { createInstagramService } = createInstagramChannelHelpers();
// Instagram reuses the existing dashboard database and conversation tables.
const instagramService = createInstagramService({ pool });


function getConversationChannel(sessionId) {
  if (String(sessionId || '').startsWith('ig:')) return 'instagram';
  return String(sessionId || '').startsWith('fb:')
    ? 'messenger'
    : 'whatsapp';
}

function getDashboardSendWebhookUrl(sessionId) {
  if (getConversationChannel(sessionId) === 'instagram') return process.env.N8N_IG_SEND_WEBHOOK_URL || null;
  return getConversationChannel(sessionId) === 'messenger'
    ? N8N_FB_SEND_WEBHOOK_URL
    : process.env.N8N_SEND_WEBHOOK_URL;
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyMessengerSignature(req) {
  if (!META_APP_SECRET || !req.rawBody) return false;

  const received = String(req.headers['x-hub-signature-256'] || '');
  if (!received.startsWith('sha256=')) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex')}`;

  return safeEqualText(received, expected);
}

async function ensureSavedRepliesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_replies (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      original_text TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

ensureSavedRepliesTable().catch((err) => {
  console.error('Failed to ensure saved_replies table:', err);
});

async function ensureSavedMediaTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_media_folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_media_items (
      id SERIAL PRIMARY KEY,
      folder_id INTEGER NOT NULL REFERENCES saved_media_folders(id) ON DELETE CASCADE,
      media_kind TEXT NOT NULL,
      media_url TEXT NOT NULL,
      thumbnail_url TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sort_order DOUBLE PRECISION
    )
  `);

  await pool.query(`
    ALTER TABLE saved_media_items ADD COLUMN IF NOT EXISTS sort_order DOUBLE PRECISION
  `);

  await pool.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_saved_media_items_folder_order
    ON saved_media_items (folder_id, sort_order, id)
  `);
}

ensureSavedMediaTables().catch((err) => {
  console.error('Failed to ensure saved_media tables:', err);
});

// ترتيب مخصص لملفات المعرض داخل كل فولدر — بنخزنه عندنا مش في درايف،
// عشان الترتيب اليدوي (Fractional Indexing) يبقى بسيط ومن غير أي تعديل
// إضافي في n8n
async function ensureGalleryOrderTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery_file_order (
      file_id TEXT PRIMARY KEY,
      sort_order DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

ensureGalleryOrderTable().catch((err) => {
  console.error('Failed to ensure gallery_file_order table:', err);
});

async function ensurePushSubscriptionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

ensurePushSubscriptionsTable().catch((err) => {
  console.error('Failed to ensure push_subscriptions table:', err);
});

async function ensureConversationUserVisibilityTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_user_visibility (
      session_id TEXT NOT NULL,
      username TEXT NOT NULL,
      is_hidden BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (session_id, username)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_conversation_user_visibility_username_hidden
    ON conversation_user_visibility (username, is_hidden, session_id)
  `);
}

ensureConversationUserVisibilityTable().catch((err) => {
  console.error('Failed to ensure conversation_user_visibility table:', err);
});

async function ensureMessengerRawEventsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_raw_events (
      id BIGSERIAL PRIMARY KEY,
      sender_id TEXT,
      recipient_id TEXT,
      event_timestamp TIMESTAMPTZ,
      event_type TEXT NOT NULL DEFAULT 'unknown',
      message_id TEXT,
      is_echo BOOLEAN,
      raw_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messenger_raw_events_created_at ON messenger_raw_events (created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messenger_raw_events_sender_id ON messenger_raw_events (sender_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messenger_raw_events_recipient_id ON messenger_raw_events (recipient_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messenger_raw_events_message_id ON messenger_raw_events (message_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messenger_raw_events_event_type ON messenger_raw_events (event_type)`);
}

ensureMessengerRawEventsTable().catch((err) => {
  console.error('Failed to ensure messenger_raw_events table:', err);
});

// عمود تتبع آخر رسالة اتقرت في كل محادثة، عشان نحسب منه عدد الرسايل الجديدة
async function ensureUnreadTrackingColumn() {
  await pool.query(`
    ALTER TABLE chat_sessions
    ADD COLUMN IF NOT EXISTS last_read_message_id BIGINT NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE chat_sessions
    ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false
  `);
}

ensureUnreadTrackingColumn().catch((err) => {
  console.error('Failed to ensure last_read_message_id/hidden columns:', err);
});

async function ensureChatPerformanceIndexes() {
  await pool.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_memory_session_id_id_desc
    ON chat_memory (session_id, id DESC)
  `);

  await pool.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_memory_user_session_id_desc
    ON chat_memory (session_id, id DESC)
    WHERE message->>'type' = 'user'
  `);

  await pool.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_memory_customer_name_session_id_desc
    ON chat_memory (session_id, id DESC)
    WHERE COALESCE(message->>'customer_name', '') <> ''
  `);

  await pool.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_memory_media_session_id_desc
    ON chat_memory (session_id, id DESC)
    WHERE message->>'message_kind' IN ('image', 'video')
  `);

  await pool.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_memory_order_confirmation_session
    ON chat_memory (session_id)
    WHERE message->>'message_kind' = 'template'
      AND message->>'template_name' = 'order_confirmation'
  `);
}

ensureChatPerformanceIndexes().catch((err) => {
  console.error('Failed to ensure chat performance indexes:', err);
});

async function ensureLabelsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_labels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#54105b',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_label_assignments (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      label_id INTEGER NOT NULL REFERENCES conversation_labels(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(session_id, label_id)
    )
  `);

  await pool.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_label_assignments_session
    ON conversation_label_assignments (session_id, label_id)
  `);
}

ensureLabelsTables().catch((err) => {
  console.error('Failed to ensure labels tables:', err);
});

async function stampLatestAgentMessage(
  sessionId,
  agentName,
  messageKind = 'text',
  messageLocator = '',
  replyTo = null,
  forcedContent = null
) {
  if (!sessionId || !agentName) return;

  // لو الرسالة دي رد على رسالة تانية، بنثبّت الـ reply_to على نفس السطر
  // عشان يفضل ظاهر بعد أي إعادة تحميل، حتى لو الـ n8n نفسه ما بيحفظوش
  const hasReplyTo = Boolean(replyTo && replyTo.content);

  // بعض ورش n8n بتحط نص غريب في content لما نبعت كابشن فاضي (بدل ما
  // تسيبه فاضي). forcedContent بيسمحلنا نثبّت نص نظيف ("📷 صورة"/"🎥 فيديو")
  // في قاعدة البيانات والداشبورد بس، من غير ما يتبعت لواتساب كـ caption فعلي
  const hasForcedContent = forcedContent !== null && forcedContent !== undefined;

  const params = [sessionId, agentName, messageKind, messageLocator];
  let setExpr = `jsonb_set(cm.message, '{agent_name}', to_jsonb($2::text), true)`;

  if (hasReplyTo) {
    params.push(JSON.stringify(replyTo));
    setExpr = `jsonb_set(${setExpr}, '{reply_to}', $${params.length}::jsonb, true)`;
  }

  if (hasForcedContent) {
    params.push(forcedContent);
    setExpr = `jsonb_set(${setExpr}, '{content}', to_jsonb($${params.length}::text), true)`;
  }

  await pool.query(
    `
    WITH target AS (
      SELECT id
      FROM chat_memory
      WHERE session_id = $1
        AND message->>'type' = 'agent'
        AND COALESCE(message->>'message_kind', 'text') = $3
        AND (
          $4 = ''
          OR message->>'media_url' = $4
          OR message->>'content' = $4
        )
      ORDER BY id DESC
      LIMIT 1
    )
    UPDATE chat_memory AS cm
    SET message = ${setExpr}
    FROM target
    WHERE cm.id = target.id
    `,
    params
  );

  const payload = {
    type: 'refresh_messages',
    sessionId,
    agentName
  };

  broadcastDashboardEvent(payload);
}

// اختبار السيرفر
app.get('/', (req, res) => {
  res.send('API is working 🚀');
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const account = findDashboardAccount(username, password);

    if (!account) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    const token = jwt.sign(
      {
        username: account.username,
        role: account.role,
        displayName: account.displayName
      },
      JWT_SECRET,
      {
        expiresIn: '30d'
      }
    );

    res.json({
      success: true,
      token,
      user: {
        username: account.username,
        role: account.role,
        displayName: account.displayName
      }
    });

  } catch (err) {
    console.error('login error:', err);

    res.status(500).json({
      error: 'Login failed'
    });
  }
});
// كل المحادثات
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const wantHidden = ['1', 'true'].includes(
      String(req.query.hidden || '').toLowerCase()
    );

    if (wantHidden && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admins only' });
    }

    const result = await pool.query(
      `
      WITH latest AS (
        SELECT DISTINCT ON (session_id)
          session_id,
          message->>'content' AS content,
          message->>'type' AS type,
          message->>'message_kind' AS message_kind,
          message->>'channel' AS channel,
          id
        FROM chat_memory
        ORDER BY session_id, id DESC
      ),
      names AS (
        SELECT DISTINCT ON (session_id)
          session_id,
          message->>'customer_name' AS customer_name
        FROM chat_memory
        WHERE COALESCE(message->>'customer_name', '') <> ''
        ORDER BY session_id, id DESC
      ),
      unread AS (
        SELECT cm.session_id, COUNT(*)::int AS unread_count
        FROM chat_memory cm
        LEFT JOIN chat_sessions cs ON cs.session_id = cm.session_id
        WHERE cm.message->>'type' = 'user'
          AND cm.id > COALESCE(cs.last_read_message_id, 0)
        GROUP BY cm.session_id
      ),
      labels_agg AS (
        SELECT
          cla.session_id,
          json_agg(
            json_build_object('id', cl.id, 'name', cl.name, 'color', cl.color)
            ORDER BY cl.id
          ) AS labels
        FROM conversation_label_assignments cla
        JOIN conversation_labels cl ON cl.id = cla.label_id
        GROUP BY cla.session_id
      ),
      confirmation_sessions AS (
        SELECT DISTINCT session_id
        FROM chat_memory
        WHERE message->>'message_kind' = 'template'
          AND message->>'template_name' = 'order_confirmation'
      ),
      visibility_agg AS (
        SELECT
          session_id,
          array_agg(username ORDER BY username) AS hidden_for_usernames
        FROM conversation_user_visibility
        WHERE is_hidden = true
        GROUP BY session_id
      )
      SELECT
        latest.session_id,
        CASE
          WHEN latest.session_id LIKE 'ig:%' THEN 'instagram'
          WHEN latest.session_id LIKE 'fb:%' THEN 'messenger'
          ELSE COALESCE(NULLIF(latest.channel, ''), 'whatsapp')
        END AS channel,
        latest.content,
        latest.type,
        latest.message_kind,
        names.customer_name,
        latest.id,
        COALESCE(unread.unread_count, 0) AS unread_count,
        (confirmation_sessions.session_id IS NOT NULL) AS is_confirmation,
        COALESCE(labels_agg.labels, '[]') AS labels,
        COALESCE(sess.hidden, false) AS hidden,
        COALESCE(visibility_agg.hidden_for_usernames, ARRAY[]::text[]) AS hidden_for_usernames
      FROM latest
      LEFT JOIN names ON latest.session_id = names.session_id
      LEFT JOIN unread ON latest.session_id = unread.session_id
      LEFT JOIN labels_agg ON latest.session_id = labels_agg.session_id
      LEFT JOIN confirmation_sessions
        ON latest.session_id = confirmation_sessions.session_id
      LEFT JOIN chat_sessions sess ON sess.session_id = latest.session_id
      LEFT JOIN visibility_agg ON visibility_agg.session_id = latest.session_id
      LEFT JOIN conversation_user_visibility user_visibility
        ON user_visibility.session_id = latest.session_id
       AND user_visibility.username = $3
       AND user_visibility.is_hidden = true
      WHERE ($2::boolean = false OR confirmation_sessions.session_id IS NOT NULL)
        AND (
          (
            $1::boolean = true
            AND (
              COALESCE(sess.hidden, false) = true
              OR visibility_agg.session_id IS NOT NULL
            )
          )
          OR (
            $1::boolean = false
            AND COALESCE(sess.hidden, false) = false
            AND ($4::boolean = true OR user_visibility.session_id IS NULL)
          )
        )
      ORDER BY latest.id DESC
      `,
      [
        wantHidden,
        req.user?.role === 'confirmation',
        req.user?.username || '',
        req.user?.role === 'admin'
      ]
    );

    const visibilityUsers = new Map(
      getConversationVisibilityUsers().map((user) => [user.username, user])
    );
    res.json(
      result.rows.map((row) => ({
        ...row,
        hidden_for: (row.hidden_for_usernames || []).map((username) => ({
          username,
          displayName: visibilityUsers.get(username)?.displayName || username
        }))
      }))
    );
  } catch (err) {
    console.error('Conversations error:', err);
    res.status(500).json({
      error: 'Error fetching conversations',
      details: err.message
    });
  }
});

async function getConversationAccessState(sessionId) {
  const result = await pool.query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM chat_sessions
         WHERE session_id = $1 AND COALESCE(hidden, false) = true
       ) AS globally_hidden,
       EXISTS (
         SELECT 1
         FROM chat_memory
         WHERE session_id = $1
           AND message->>'message_kind' = 'template'
           AND message->>'template_name' = 'order_confirmation'
       ) AS is_confirmation,
       COALESCE(
         (
           SELECT array_agg(username)
           FROM conversation_user_visibility
           WHERE session_id = $1 AND is_hidden = true
         ),
         ARRAY[]::text[]
       ) AS hidden_for_usernames`,
    [sessionId]
  );

  const row = result.rows[0] || {};
  return {
    globallyHidden: Boolean(row.globally_hidden),
    isConfirmation: Boolean(row.is_confirmation),
    hiddenForUsernames: new Set(row.hidden_for_usernames || [])
  };
}

function canDashboardUserAccessConversation(user, accessState) {
  if (!user || !accessState) return false;
  if (user.role === 'admin') return true;
  if (!['agent', 'confirmation'].includes(user.role)) return false;
  if (accessState.globallyHidden) return false;
  if (accessState.hiddenForUsernames.has(user.username)) return false;
  if (user.role === 'confirmation' && !accessState.isConfirmation) return false;
  return true;
}

function requireConversationRole(req, res, next) {
  if (!['admin', 'agent', 'confirmation'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Conversation access only' });
  }
  next();
}

async function canRequestAccessConversation(req, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return false;
  const normalizedSessionId = sessionId.trim();
  if (!['admin', 'agent', 'confirmation'].includes(req.user?.role)) return false;
  if (req.user.role === 'admin') return true;
  const accessState = await getConversationAccessState(normalizedSessionId);
  if (canDashboardUserAccessConversation(req.user, accessState)) return true;
  if (options.allowTemporary && canUseTemporaryOrderConfirmationAccess(req, normalizedSessionId, accessState)) {
    return true;
  }
  // Only the signed-link context endpoint may use this option, after signature validation.
  return Boolean(
    options.signedOrderContext && req.user.role === 'confirmation' &&
    !accessState.globallyHidden &&
    !accessState.hiddenForUsernames.has(req.user.username)
  );
}

async function authorizeConversationRequest(req, res, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    res.status(400).json({ error: 'sessionId is required' });
    return false;
  }
  try {
    if (await canRequestAccessConversation(req, sessionId, options)) return true;
    res.status(403).json({ error: 'Forbidden: conversation is not available for this user' });
  } catch (err) {
    console.error('Conversation authorization failed:', err.code || 'lookup_failed');
    res.status(503).json({ error: 'Unable to verify conversation access' });
  }
  return false;
}

function requireConversationAccess(options = {}) {
  return async (req, res, next) => {
    const sessionId = req.params?.sessionId ?? req.body?.sessionId;
    if (await authorizeConversationRequest(req, res, sessionId, options)) next();
  };
}

// Serialize broadcasts so asynchronous authorization cannot invert message order.
let dashboardBroadcastQueue = Promise.resolve();
function broadcastDashboardEvent(payload) {
  const dispatch = async () => {
    const suppliedIds = [payload?.sessionId, payload?.session_id];
    if (suppliedIds.some((id) => id != null && typeof id !== 'string')) return;
    const [camelId, snakeId] = suppliedIds.map((id) => (id || '').trim());
    if (camelId && snakeId && camelId !== snakeId) return;
    const sessionId = camelId || snakeId;
    let event = payload;
    if (!sessionId) {
      // Session-free events contain invalidation metadata only, never message content.
      const globalTypes = ['conversations_changed', 'label_changed', 'saved_replies_changed', 'test_event'];
      if (globalTypes.includes(payload?.type)) event = { type: payload.type };
      else if (payload?.type === 'unread_changed' && payload.all === true) {
        event = { type: 'unread_changed', sessionId: null, all: true };
      } else return;
    }

    const recipients = [];
    for (const client of clients) {
      if (client.res.destroyed || client.res.writableEnded ||
          (client.expiresAt && Date.now() >= client.expiresAt)) {
        clients.delete(client);
        if (!client.res.writableEnded) client.res.end();
        continue;
      }
      const account = findDashboardAccountByUsername(client.username);
      if (account && ['admin', 'agent', 'confirmation'].includes(account.role)) {
        recipients.push({ client, account });
      }
    }

    let accessState = null;
    if (sessionId && recipients.some(({ account }) => account.role !== 'admin')) {
      // One fresh lookup per event, shared by recipients. Never cache visibility across events.
      try {
        accessState = await getConversationAccessState(sessionId);
      } catch (err) {
        // Admin needs no visibility lookup; all other recipients fail closed.
        console.error('SSE authorization lookup failed:', err.code || 'lookup_failed');
      }
    }
    for (const { client, account } of recipients) {
      if (sessionId && account.role !== 'admin' &&
          !canDashboardUserAccessConversation(account, accessState)) continue;
      if (!clients.has(client) || client.res.destroyed || client.res.writableEnded) continue;
      if (client.expiresAt && Date.now() >= client.expiresAt) {
        clients.delete(client);
        client.res.end();
        continue;
      }
      try {
        client.res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        clients.delete(client);
      }
    }
  };
  dashboardBroadcastQueue = dashboardBroadcastQueue.then(dispatch).catch((err) => {
    // Unexpected dispatcher failures must not escape into request handlers.
    console.error('SSE authorization failed:', err.code || 'broadcast_failed');
  });
  return dashboardBroadcastQueue;
}

app.get('/api/conversations/:sessionId/visibility', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = getConversationVisibilityUsers();
    const result = await pool.query(
      `SELECT username
       FROM conversation_user_visibility
       WHERE session_id = $1 AND is_hidden = true`,
      [req.params.sessionId]
    );
    const hiddenFor = new Set(result.rows.map((row) => row.username));

    res.json({
      sessionId: req.params.sessionId,
      users: users.map((user) => ({ ...user, hidden: hiddenFor.has(user.username) })),
      hiddenFor: users
        .filter((user) => hiddenFor.has(user.username))
        .map((user) => user.username)
    });
  } catch (err) {
    console.error('Conversation visibility fetch error:', err);
    res.status(500).json({ error: 'Error fetching conversation visibility' });
  }
});

app.post('/api/conversations/:sessionId/visibility', requireAuth, requireAdmin, async (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const requested = Array.isArray(req.body?.hiddenFor)
    ? [...new Set(req.body.hiddenFor.map((value) => String(value || '').trim()).filter(Boolean))]
    : null;
  const allowedUsers = getConversationVisibilityUsers();
  const allowedUsernames = new Set(allowedUsers.map((user) => user.username));

  if (!requested || requested.some((username) => !allowedUsernames.has(username))) {
    return res.status(400).json({ error: 'Invalid visibility username' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM conversation_user_visibility WHERE session_id = $1',
      [sessionId]
    );

    if (requested.length) {
      await client.query(
        `INSERT INTO conversation_user_visibility (session_id, username, is_hidden, updated_at)
         SELECT $1, username, true, now()
         FROM unnest($2::text[]) AS username`,
        [sessionId, requested]
      );
    }

    await client.query('COMMIT');
    broadcastConversationsChanged();
    res.json({ success: true, sessionId, hiddenFor: requested });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Conversation visibility update error:', err);
    res.status(500).json({ error: 'Error updating conversation visibility' });
  } finally {
    client.release();
  }
});

// رسائل محادثة واحدة
// Search across the complete conversation history, not only the latest preview.
app.get('/api/conversations-search', requireAuth, async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.json({ sessionIds: [] });
  }

  try {
    const result = await pool.query(
      `
      SELECT cm.session_id
      FROM chat_memory cm
      WHERE (
        cm.session_id ILIKE $1
        OR COALESCE(cm.message->>'customer_name', '') ILIKE $1
        OR COALESCE(cm.message->>'content', '') ILIKE $1
      )
        AND (
          $2::boolean = false
          OR EXISTS (
            SELECT 1
            FROM chat_memory confirmation
            WHERE confirmation.session_id = cm.session_id
              AND confirmation.message->>'message_kind' = 'template'
              AND confirmation.message->>'template_name' = 'order_confirmation'
          )
        )
        AND (
          $3::boolean = true
          OR NOT EXISTS (
            SELECT 1
            FROM conversation_user_visibility visibility
            WHERE visibility.session_id = cm.session_id
              AND visibility.username = $4
              AND visibility.is_hidden = true
          )
        )
      GROUP BY cm.session_id
      ORDER BY MAX(cm.id) DESC
      LIMIT 500
      `,
      [
        `%${query}%`,
        req.user?.role === 'confirmation',
        req.user?.role === 'admin',
        req.user?.username || ''
      ]
    );

    res.json({
      sessionIds: result.rows.map((row) => row.session_id)
    });
  } catch (err) {
    console.error('Conversation search error:', err);
    res.status(500).json({
      error: 'Error searching conversations',
      details: err.message
    });
  }
});

app.get('/api/messages/:sessionId', requireAuth, requireConversationAccess({ allowTemporary: true }), async (req, res) => {
  const { sessionId } = req.params;
  const limit = Math.min(
    Math.max(Number(req.query.limit || 100), 1),
    100
  );
  const beforeId = req.query.beforeId
    ? Number(req.query.beforeId)
    : null;
  const parsedBeforeTimestamp = req.query.beforeTimestamp
    ? new Date(String(req.query.beforeTimestamp))
    : null;
  const beforeTimestamp =
    parsedBeforeTimestamp && Number.isFinite(parsedBeforeTimestamp.getTime())
      ? parsedBeforeTimestamp.toISOString()
      : null;
  const isMessengerSession = /^(fb:|ig:)/.test(String(sessionId || ''));

  try {
    const [result, countResult] = await Promise.all([
      pool.query(
      `
      WITH ordered_messages AS (
        SELECT
          id,
          session_id,
          created_at,
          message,
          message->>'type' AS type,
          message->>'content' AS content,
          message->>'message_kind' AS message_kind,
          CASE
            WHEN (session_id LIKE 'fb:%' OR session_id LIKE 'ig:%')
              AND COALESCE(message->>'timestamp', '') ~ '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}'
            THEN (message->>'timestamp')::timestamptz
            ELSE created_at
          END AS sort_timestamp
        FROM chat_memory
        WHERE session_id = $1
      ), page AS (
        SELECT *
        FROM ordered_messages
        WHERE (
          $5::boolean
          AND (
            (
              $2::timestamptz IS NOT NULL
              AND (
                sort_timestamp < $2::timestamptz
                OR (sort_timestamp = $2::timestamptz AND id < $3::bigint)
              )
            ) OR (
              $2::timestamptz IS NULL
              AND ($3::bigint IS NULL OR id < $3::bigint)
            )
          )
        ) OR (
          NOT $5::boolean
          AND ($3::bigint IS NULL OR id < $3::bigint)
        )
        ORDER BY
          CASE WHEN $5::boolean THEN sort_timestamp END DESC,
          id DESC
        LIMIT $4
      )
      SELECT * FROM page
      ORDER BY
        CASE WHEN $5::boolean THEN sort_timestamp END ASC,
        id ASC
      `,
      [sessionId, beforeTimestamp, beforeId, limit + 1, isMessengerSession]
      ),
      pool.query(
        `SELECT COALESCE(SUM(
          CASE WHEN session_id LIKE 'fb:%'
            AND message->>'channel' = 'messenger'
            AND jsonb_typeof(message->'attachments') = 'array'
          THEN CASE WHEN NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(message->'attachments') a
            WHERE COALESCE(a->>'type', split_part(a->>'mime_type', '/', 1), '') <> 'image'
          ) THEN GREATEST(1, (
            SELECT COUNT(DISTINCT COALESCE(a#>>'{payload,url}', a#>>'{image_data,url}', a->>'url'))
            FROM jsonb_array_elements(message->'attachments') a
            WHERE COALESCE(a#>>'{payload,url}', a#>>'{image_data,url}', a->>'url', '') ~ '^https?://[^/@]+(/|$)'
          )) ELSE 1 END ELSE 1 END
        ), 0)::int AS total FROM chat_memory WHERE session_id = $1`,
        [sessionId]
      )
    ]);

    const hasMore = result.rows.length > limit;
    const pageRows = hasMore
      ? result.rows.slice(result.rows.length - limit)
      : result.rows;

    res.json({
      messages: pageRows,
      total: countResult.rows[0]?.total || 0,
      hasMore,
      nextBeforeId: pageRows[0]?.id || null,
      nextBeforeTimestamp: pageRows[0]?.sort_timestamp || null
    });
  } catch (err) {
    console.error('Messages error:', err);
    res.status(500).json({
      error: 'Error fetching messages',
      details: err.message
    });
  }
});

// صور وفيديوهات محادثة واحدة للمعرض
app.get('/api/media/:sessionId', requireAuth, requireConversationAccess({ allowTemporary: true }), async (req, res) => {
  const { sessionId } = req.params;
  const limit = Math.min(
    Math.max(Number(req.query.limit || 48), 1),
    60
  );
  const beforeId = req.query.beforeId
    ? Number(req.query.beforeId)
    : null;

  try {
    const [result, countResult] = await Promise.all([
      pool.query(
        `
        SELECT
          id,
          created_at,
          message
        FROM chat_memory
        WHERE session_id = $1
          AND message->>'message_kind' IN ('image', 'video')
          AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC
        LIMIT $3
        `,
        [sessionId, beforeId, limit + 1]
      ),
      pool.query(
        `
        SELECT COUNT(*)::int AS total
        FROM chat_memory
        WHERE session_id = $1
          AND message->>'message_kind' IN ('image', 'video')
        `,
        [sessionId]
      )
    ]);

    const hasMore = result.rows.length > limit;
    const pageRows = result.rows.slice(0, limit);

    const mediaItems = pageRows
      .map((row) => {
        let message = row.message || {};

        if (typeof message === 'string') {
          try {
            message = JSON.parse(message);
          } catch (error) {
            message = {};
          }
        }

        const whatsappMessage = message.whatsapp_message || {};
        const messageKind = String(
          message.message_kind ||
          message.messageKind ||
          whatsappMessage.type ||
          ''
        ).toLowerCase();

        if (!['image', 'video'].includes(messageKind)) {
          return null;
        }

        const mediaObject = message.media || {};
        const whatsappMedia = whatsappMessage[messageKind] || {};

        const mediaUrl =
          message.media_url ||
          message.mediaUrl ||
          (typeof mediaObject === 'string' ? mediaObject : mediaObject.url) ||
          mediaObject?.[messageKind]?.url ||
          mediaObject?.[messageKind]?.link ||
          whatsappMedia.url ||
          whatsappMedia.link ||
          '';

        if (!mediaUrl) return null;

        return {
          id: row.id,
          created_at: row.created_at,
          type: message.type || '',
          agent_name: message.agent_name || '',
          content: message.content || '',
          message_kind: messageKind,
          media_url: String(mediaUrl).replace('http://', 'https://')
        };
      })
      .filter(Boolean);

    res.json({
      items: mediaItems,
      total: countResult.rows[0]?.total || 0,
      hasMore,
      nextBeforeId: pageRows[pageRows.length - 1]?.id || null
    });
  } catch (err) {
    console.error('Media gallery error:', err);
    res.status(500).json({
      error: 'Error fetching chat media',
      details: err.message
    });
  }
});

// Health
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/instagram/status', requireAuth, requireAdmin, async (req, res) => {
  let workerReady = false;
  try { workerReady = await instagramService.ready(); } catch { /* fail closed */ }
  return res.json({
    channel: 'instagram', accountId: INSTAGRAM_ACCOUNT_ID,
    databaseConfigured: !!pool, ingressEnabled: INSTAGRAM_INGRESS_ENABLED,
    databaseReachable: workerReady, receivingWorkflowConfigured: !!process.env.N8N_INSTAGRAM_WORKER_WEBHOOK_URL, sendingEnabled: process.env.INSTAGRAM_OUTBOUND_ENABLED === 'true',
    outboundWebhookConfigured: !!process.env.N8N_IG_SEND_WEBHOOK_URL
  });
});

// Instagram webhook: verify first; acknowledge only durable inbox acceptance.
app.get('/api/webhooks/instagram', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (
    INSTAGRAM_VERIFY_TOKEN && mode === 'subscribe' &&
    typeof token === 'string' && typeof challenge === 'string' &&
    challenge.length > 0 && challenge.length <= 2048 &&
    safeEqualText(token, INSTAGRAM_VERIFY_TOKEN)
  ) {
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/api/webhooks/instagram', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!INSTAGRAM_APP_SECRET || !/^\d+$/.test(INSTAGRAM_ACCOUNT_ID)) {
    res.setHeader('Retry-After', '60');
    return res.status(503).json({ error: 'Instagram webhook is not configured' });
  }
  const signature = req.headers['x-hub-signature-256'];
  if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature) || !Buffer.isBuffer(req.rawBody)) {
    return res.sendStatus(401);
  }
  const expected = crypto.createHmac('sha256', INSTAGRAM_APP_SECRET).update(req.rawBody).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  if (!crypto.timingSafeEqual(received, expected)) return res.sendStatus(401);

  const body = req.body;
  if (!body || body.object !== 'instagram') return res.sendStatus(400);
  if (!Array.isArray(body.entry) || body.entry.length === 0 || body.entry.some(entry =>
    !entry || typeof entry.id !== 'string' || !/^\d+$/.test(entry.id)
  )) return res.sendStatus(400);
  // Validate every entry, not just the first, to reject mixed-account batches.
  if (body.entry.some(entry => entry.id !== INSTAGRAM_ACCOUNT_ID)) return res.sendStatus(403);

  if (!INSTAGRAM_INGRESS_ENABLED) {
    res.setHeader('Retry-After', '60');
    return res.status(503).json({ error: 'Instagram ingress is not enabled yet' });
  }
  let eventCount = 0;
  for (const entry of body.entry) {
    if (!Object.hasOwn(entry, 'messaging') && !Object.hasOwn(entry, 'standby')) return res.sendStatus(400);
    for (const source of ['messaging', 'standby']) {
      if (!Object.hasOwn(entry, source)) continue;
      const events = entry[source];
      if (!Array.isArray(events) || events.some(event => !event || typeof event !== 'object' || Array.isArray(event))) return res.sendStatus(400);
      eventCount += events.length;
    }
  }
  if (!eventCount) return res.sendStatus(400);
  if (eventCount > 500) return res.sendStatus(413);

  // n8n saves messages in the existing chat tables before returning its ACK.
  return (async () => {
    try {
      const accepted = await instagramService.receive(body, eventCount);
      return res.status(200).json(accepted);
    } catch {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: 'Instagram persistence was not confirmed' });
    }
  })();
});

// Meta Messenger Webhook verification.
app.get('/api/webhooks/messenger', (req, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');

  if (
    mode === 'subscribe' &&
    META_VERIFY_TOKEN &&
    safeEqualText(token, META_VERIFY_TOKEN)
  ) {
    console.log('[MESSENGER] Webhook verified');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Verify authenticity first, acknowledge Meta quickly, then let the dedicated
// n8n workflow normalize, deduplicate and process individual messaging events.
app.post('/api/webhooks/messenger', (req, res) => {
  logMessengerWebhookDiagnostic(req, 'route');
  const signatureVerified = verifyMessengerSignature(req);
  // TEMPORARY diagnostics: these counters describe untrusted input shape only.
  // Never log payload values, headers, identities, text or attachment content.
  const ingressEntries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  const ingress = {
    object: req.body?.object === 'page' ? 'page' : 'other',
    entry: ingressEntries.length,
    messaging: 0,
    standby: 0,
    changes: 0,
    message: 0,
    is_echo: 0,
    read: 0,
    signatureVerified
  };
  for (const entry of ingressEntries) {
    const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];
    const standby = Array.isArray(entry?.standby) ? entry.standby : [];
    ingress.messaging += messaging.length;
    ingress.standby += standby.length;
    ingress.changes += Array.isArray(entry?.changes) ? entry.changes.length : 0;
    // Event counters apply to messaging/standby, not arbitrary changes values.
    for (const events of [messaging, standby]) {
      for (const event of events) {
        if (event?.message && typeof event.message === 'object' && !Array.isArray(event.message)) {
          ingress.message += 1;
          if (event.message.is_echo === true) ingress.is_echo += 1;
        }
        if (event?.read && typeof event.read === 'object' && !Array.isArray(event.read)) ingress.read += 1;
      }
    }
  }
  logMessengerWebhookDiagnostic(req, 'signature', {
    ...ingress,
    hasEcho: ingress.is_echo > 0,
    payloadTrust: signatureVerified ? 'verified' : 'unverified'
  });
  if (!signatureVerified) {
    if (!req[messengerDiagnosticContext]) console.warn('[MESSENGER] Rejected webhook with invalid signature');
    return res.sendStatus(401);
  }

  const body = req.body || {};
  if (body.object !== 'page') return res.sendStatus(404);

  res.sendStatus(200);

  if (!N8N_MESSENGER_WEBHOOK_URL) {
    logMessengerWebhookDiagnostic(req, 'forward_result', { outcome: 'not_configured' });
    if (!req[messengerDiagnosticContext]) console.error('[MESSENGER] N8N_MESSENGER_WEBHOOK_URL is missing');
    return;
  }

  const events = (Array.isArray(body.entry) ? body.entry : [])
    .flatMap((entry) => [
      ...(Array.isArray(entry.messaging) ? entry.messaging : []).map((event) => ({
        object: body.object,
        pageId: String(entry.id || ''),
        entryTime: entry.time || null,
        eventSource: 'messaging',
        event
      })),
      ...(Array.isArray(entry.standby) ? entry.standby : []).map((event) => ({
        object: body.object,
        pageId: String(entry.id || ''),
        entryTime: entry.time || null,
        eventSource: 'standby',
        event
      }))
    ]);

  if (events.length === 0) logMessengerWebhookDiagnostic(req, 'forward_result', { outcome: 'no_events', eventCount: 0 });
  // Retain only the generated trace context while forwarding, not the request.
  const forwardDiagnosticRequest = { [messengerDiagnosticContext]: req[messengerDiagnosticContext] };
  let eventIndex = 0;
  for (const item of events) {
    const diagnosticEventIndex = eventIndex++;
    const diagnosticIsEcho = item.event?.message?.is_echo === true;
    fetch(N8N_MESSENGER_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.INTERNAL_API_TOKEN || ''
      },
      body: JSON.stringify(item)
    }).then((response) => {
      logMessengerWebhookDiagnostic(forwardDiagnosticRequest, 'forward_result', {
        outcome: response.ok ? 'accepted' : 'rejected',
        httpStatus: response.status,
        eventIndex: diagnosticEventIndex,
        isEcho: diagnosticIsEcho
      });
    }).catch(() => {
      logMessengerWebhookDiagnostic(forwardDiagnosticRequest, 'forward_result', {
        outcome: 'failed', errorKind: 'network_error',
        eventIndex: diagnosticEventIndex,
        isEcho: diagnosticIsEcho
      });
      if (!forwardDiagnosticRequest[messengerDiagnosticContext]) console.error('[MESSENGER] n8n forward failed');
    });
  }
});

// SSE test
app.get('/api/test-event', requireAuth, requireConversationRole, (req, res) => {
  const payload = {
    type: 'test_event',
    message: 'Hello from server 🔥',
    time: new Date().toISOString()
  };

  broadcastDashboardEvent(payload);

  res.json({ sent: true });
});

// SSE stream
app.get('/api/events', requireAuth, requireConversationRole, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ connected: true })}\n\n`);

  const client = {
    res,
    username: req.user.username,
    expiresAt: req.user.exp ? Number(req.user.exp) * 1000 : null
  };
  clients.add(client);

  req.on('close', () => {
    clients.delete(client);
  });
});

// Push realtime update
app.post('/api/push-update', (req, res) => {
  const secret = req.headers['x-dashboard-secret'];

  if (secret !== process.env.DASHBOARD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body || {
    message: 'New update',
    time: new Date().toISOString()
  };

  broadcastDashboardEvent(payload);

  console.log(
    `push-update received: type=${payload.type} messageType=${payload.messageType} sessionId=${payload.sessionId}`
  );

  // رسالة عميل جديدة فعلية: n8n بيبعتها كـ type=new_message مع messageType=user
  // (مش user_message زي ما كنا مفترضين قبل كده — ده كان سبب عدم ظهور الإشعارات خالص)
  if (
    payload.type === 'new_message' &&
    payload.sessionId &&
    payload.messageType === 'user' &&
    payload.source !== 'history_sync'
  ) {
    sendNewMessagePush(payload.sessionId, payload).catch((err) => {
      console.error('push notification error:', err);
    });
  } else {
    console.log(
      'push-update: not a new customer message, skipping push'
    );
  }

  res.json({ sent: true });
});

async function getCustomerNameForSession(sessionId) {
  try {
    const result = await pool.query(
      `SELECT message->>'customer_name' AS customer_name
       FROM chat_memory
       WHERE session_id = $1 AND COALESCE(message->>'customer_name', '') <> ''
       ORDER BY id DESC
       LIMIT 1`,
      [sessionId]
    );

    return result.rows[0]?.customer_name || '';
  } catch (err) {
    return '';
  }
}

async function sendPushToAllSubscriptions(payload, options = {}) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('sendPushToAllSubscriptions: VAPID keys missing, skipping');
    return;
  }

  const result = await pool.query(
    'SELECT id, endpoint, p256dh, auth, created_by FROM push_subscriptions'
  );

  let rows = result.rows;

  if (options.sessionId) {
    const accessState = options.accessState ||
      await getConversationAccessState(options.sessionId);
    const before = rows.length;

    rows = rows.filter((row) => {
      const account = findDashboardAccountByUsername(row.created_by);
      return canDashboardUserAccessConversation(account, accessState);
    });

    console.log(
      `sendPushToAllSubscriptions: conversation access filter kept ${rows.length}/${before} subscription(s)`
    );
  // الحفاظ على المسار القديم لأي استدعاء آخر لا يمرر sessionId.
  } else if (options.adminOnly) {
    const before = rows.length;
    rows = rows.filter((row) => row.created_by === DASHBOARD_USERNAME);
    console.log(
      `sendPushToAllSubscriptions: hidden conversation, restricting to admin subscriptions (${rows.length}/${before})`
    );
  } else if (Array.isArray(options.hiddenUsernames) && options.hiddenUsernames.length) {
    const hiddenUsernames = new Set(options.hiddenUsernames);
    rows = rows.filter(
      (row) =>
        row.created_by === DASHBOARD_USERNAME ||
        !hiddenUsernames.has(row.created_by)
    );
  }

  console.log(
    `sendPushToAllSubscriptions: sending to ${rows.length} subscription(s)`
  );

  const body = JSON.stringify(payload);

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth }
          },
          body
        );
        console.log(`push send OK -> subscription #${row.id}`);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.warn(
            `push subscription #${row.id} expired (status ${err.statusCode}), removing`
          );
          await pool
            .query('DELETE FROM push_subscriptions WHERE id = $1', [row.id])
            .catch(() => {});
        } else {
          console.error(
            `push send error -> subscription #${row.id}: status=${err.statusCode} message=${err.message}`
          );
        }
      }
    })
  );
}

function buildPushBodyText(payload) {
  if (payload.content && payload.content !== '__image__') {
    return String(payload.content).slice(0, 120);
  }

  const kind = String(
    payload.messageKind || payload.message_kind || ''
  ).toLowerCase();

  if (kind === 'image') return '📷 صورة';
  if (kind === 'video') return '🎥 فيديو';
  if (kind === 'audio') return '🎙️ رسالة صوتية';
  if (kind === 'document') return '📄 ملف';
  if (kind === 'sticker') return '🖼️ ملصق';

  return String(payload.message || '📩 رسالة جديدة').slice(0, 120);
}

async function sendNewMessagePush(sessionId, payload) {
  if (payload?.source === 'history_sync') return;

  console.log(`sendNewMessagePush: triggered for session ${sessionId}`);

  const accessState = await getConversationAccessState(sessionId);
  const customerName = (await getCustomerNameForSession(sessionId)) || 'عميل';
  const body = buildPushBodyText(payload);

  await sendPushToAllSubscriptions(
    {
      title: customerName,
      body,
      sessionId,
      url: '/'
    },
    {
      sessionId,
      accessState
    }
  );
}

// مفتاح VAPID العام عشان الواجهة تشترك في الإشعارات
app.get('/api/push/public-key', requireAuth, (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// تشخيص سريع: كام جهاز مشترك فعليًا في الإشعارات دلوقتي
app.get('/api/push/debug', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, created_by, created_at, endpoint
       FROM push_subscriptions
       ORDER BY id DESC`
    );

    res.json({
      vapidConfigured: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      count: result.rows.length,
      subscriptions: result.rows.map((row) => {
        let host = 'invalid-endpoint';
        try {
          host = new URL(row.endpoint).host;
        } catch (e) {
          // ignore
        }

        return {
          id: row.id,
          created_by: row.created_by,
          created_at: row.created_at,
          push_service: host
        };
      })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/push-subscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    const createdBy = req.user?.username || '';

    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint)
       DO UPDATE SET
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         created_by = EXCLUDED.created_by`,
      [endpoint, keys.p256dh, keys.auth, createdBy]
    );

    console.log(
      `push-subscribe: saved subscription for ${createdBy || 'unknown user'} (endpoint host: ${
        new URL(endpoint).host
      })`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('push-subscribe error:', err);
    res.status(500).json({
      error: 'Error saving push subscription',
      details: err.message
    });
  }
});

app.post('/api/push-unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};

    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }

    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [
      endpoint
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('push-unsubscribe error:', err);
    res.status(500).json({
      error: 'Error removing push subscription',
      details: err.message
    });
  }
});

// تحديد المحادثة كمقروءة، ويصفّر عداد الرسايل الجديدة لأي جهاز فاتح الداشبورد
app.post(
  '/api/conversations/:sessionId/mark-read',
  requireAuth,
  async (req, res) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const latest = await pool.query(
        `SELECT COALESCE(MAX(id), 0)::bigint AS max_id
         FROM chat_memory
         WHERE session_id = $1`,
        [sessionId]
      );

      const maxId = latest.rows[0]?.max_id || 0;

      await pool.query(
        `INSERT INTO chat_sessions (session_id, last_read_message_id)
         VALUES ($1, $2)
         ON CONFLICT (session_id)
         DO UPDATE SET last_read_message_id = GREATEST(
           chat_sessions.last_read_message_id, EXCLUDED.last_read_message_id
         )`,
        [sessionId, maxId]
      );

      const payload = {
        type: 'unread_changed',
        sessionId,
        unreadCount: 0
      };

      broadcastDashboardEvent(payload);

      res.json({ success: true, sessionId });
    } catch (err) {
      console.error('mark-read error:', err);
      res.status(500).json({
        error: 'Error marking conversation as read',
        details: err.message
      });
    }
  }
);

// تحديد كل المحادثات كمقروءة دفعة واحدة
app.post(
  '/api/conversations/mark-all-read',
  requireAuth,
  async (req, res) => {
    try {
      await pool.query(`
        INSERT INTO chat_sessions (session_id, last_read_message_id)
        SELECT session_id, MAX(id) FROM chat_memory GROUP BY session_id
        ON CONFLICT (session_id)
        DO UPDATE SET last_read_message_id = GREATEST(
          chat_sessions.last_read_message_id, EXCLUDED.last_read_message_id
        )
      `);

      const payload = {
        type: 'unread_changed',
        sessionId: null,
        all: true
      };

      broadcastDashboardEvent(payload);

      res.json({ success: true });
    } catch (err) {
      console.error('mark-all-read error:', err);
      res.status(500).json({
        error: 'Error marking all conversations as read',
        details: err.message
      });
    }
  }
);

function broadcastConversationsChanged() {
  const payload = { type: 'conversations_changed' };

  broadcastDashboardEvent(payload);
}

function parseSessionIds(body) {
  const ids = Array.isArray(body?.sessionIds) ? body.sessionIds : [];
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

// إخفاء مجموعة محادثات من القايمة الرئيسية
app.post('/api/conversations/hide', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sessionIds = parseSessionIds(req.body);
    if (!sessionIds.length) {
      return res.status(400).json({ error: 'sessionIds is required' });
    }

    await pool.query(
      `INSERT INTO chat_sessions (session_id, hidden)
       SELECT unnest($1::text[]), true
       ON CONFLICT (session_id)
       DO UPDATE SET hidden = true`,
      [sessionIds]
    );

    broadcastConversationsChanged();
    res.json({ success: true, count: sessionIds.length });
  } catch (err) {
    console.error('conversations/hide error:', err);
    res.status(500).json({
      error: 'Error hiding conversations',
      details: err.message
    });
  }
});

// إظهار مجموعة محادثات كانت مخفية
app.post('/api/conversations/unhide', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sessionIds = parseSessionIds(req.body);
    if (!sessionIds.length) {
      return res.status(400).json({ error: 'sessionIds is required' });
    }

    await pool.query(
      `UPDATE chat_sessions SET hidden = false
       WHERE session_id = ANY($1::text[])`,
      [sessionIds]
    );

    broadcastConversationsChanged();
    res.json({ success: true, count: sessionIds.length });
  } catch (err) {
    console.error('conversations/unhide error:', err);
    res.status(500).json({
      error: 'Error unhiding conversations',
      details: err.message
    });
  }
});

// تحديد مجموعة محادثات محددة كمقروءة دفعة واحدة
app.post(
  '/api/conversations/mark-read-batch',
  requireAuth,
  async (req, res) => {
    try {
      const sessionIds = parseSessionIds(req.body);
      if (!sessionIds.length) {
        return res.status(400).json({ error: 'sessionIds is required' });
      }

      await pool.query(
        `
        INSERT INTO chat_sessions (session_id, last_read_message_id)
        SELECT cm.session_id, MAX(cm.id)
        FROM chat_memory cm
        WHERE cm.session_id = ANY($1::text[])
        GROUP BY cm.session_id
        ON CONFLICT (session_id)
        DO UPDATE SET last_read_message_id = GREATEST(
          chat_sessions.last_read_message_id, EXCLUDED.last_read_message_id
        )
        `,
        [sessionIds]
      );

      for (const sessionId of sessionIds) {
        const payload = { type: 'unread_changed', sessionId, unreadCount: 0 };
        broadcastDashboardEvent(payload);
      }

      res.json({ success: true, count: sessionIds.length });
    } catch (err) {
      console.error('mark-read-batch error:', err);
      res.status(500).json({
        error: 'Error marking conversations as read',
        details: err.message
      });
    }
  }
);

function broadcastLabelChanged(sessionId) {
  const payload = { type: 'label_changed', sessionId: sessionId || null };

  broadcastDashboardEvent(payload);
}

// كل الليبلز المتاحة (كل الأدوار تقدر تشوفها عشان تلزّق أي ليبل على أي محادثة)
app.get('/api/labels', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, color FROM conversation_labels ORDER BY id ASC`
    );

    res.json({
      labels: result.rows,
      canManage: req.user?.role === 'admin'
    });
  } catch (err) {
    console.error('labels list error:', err);
    res.status(500).json({
      error: 'Error fetching labels',
      details: err.message
    });
  }
});

// إنشاء ليبل جديد (أدمن فقط)
app.post('/api/labels', requireAuth, requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const color = String(req.body?.color || '#54105b').trim();

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const createdBy = req.user?.username || '';

    const result = await pool.query(
      `INSERT INTO conversation_labels (name, color, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, name, color`,
      [name, color, createdBy]
    );

    broadcastLabelChanged(null);

    res.json({ success: true, label: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'الاسم ده مستخدم بالفعل' });
    }

    console.error('labels create error:', err);
    res.status(500).json({
      error: 'Error creating label',
      details: err.message
    });
  }
});

// تعديل ليبل (أدمن فقط)
app.put('/api/labels/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    const color = String(req.body?.color || '#54105b').trim();

    if (!id || !name) {
      return res.status(400).json({
        error: 'Valid id and name are required'
      });
    }

    const result = await pool.query(
      `UPDATE conversation_labels SET name = $1, color = $2 WHERE id = $3
       RETURNING id, name, color`,
      [name, color, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Label not found' });
    }

    broadcastLabelChanged(null);

    res.json({ success: true, label: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'الاسم ده مستخدم بالفعل' });
    }

    console.error('labels update error:', err);
    res.status(500).json({
      error: 'Error updating label',
      details: err.message
    });
  }
});

// حذف ليبل (أدمن فقط) — بيتشال تلقائيًا من كل المحادثات اللي حاطاه
app.delete('/api/labels/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const result = await pool.query(
      `DELETE FROM conversation_labels WHERE id = $1 RETURNING id`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Label not found' });
    }

    broadcastLabelChanged(null);

    res.json({ success: true, id });
  } catch (err) {
    console.error('labels delete error:', err);
    res.status(500).json({
      error: 'Error deleting label',
      details: err.message
    });
  }
});

// ليبلز محادثة معيّنة
app.get(
  '/api/conversations/:sessionId/labels',
  requireAuth,
  async (req, res) => {
    try {
      const { sessionId } = req.params;

      const result = await pool.query(
        `SELECT cl.id, cl.name, cl.color
         FROM conversation_label_assignments cla
         JOIN conversation_labels cl ON cl.id = cla.label_id
         WHERE cla.session_id = $1
         ORDER BY cl.id ASC`,
        [sessionId]
      );

      res.json({ labels: result.rows });
    } catch (err) {
      console.error('conversation labels list error:', err);
      res.status(500).json({
        error: 'Error fetching conversation labels',
        details: err.message
      });
    }
  }
);

// إضافة ليبل لمحادثة (أدمن أو إيجنت)
app.post(
  '/api/conversations/:sessionId/labels',
  requireAuth,
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      const labelId = Number(req.body?.labelId);

      if (!sessionId || !labelId) {
        return res.status(400).json({
          error: 'Valid sessionId and labelId are required'
        });
      }

      await pool.query(
        `INSERT INTO conversation_label_assignments (session_id, label_id)
         VALUES ($1, $2)
         ON CONFLICT (session_id, label_id) DO NOTHING`,
        [sessionId, labelId]
      );

      broadcastLabelChanged(sessionId);

      res.json({ success: true });
    } catch (err) {
      console.error('conversation label attach error:', err);
      res.status(500).json({
        error: 'Error attaching label',
        details: err.message
      });
    }
  }
);

// إضافة ليبل لمجموعة محادثات دفعة واحدة (أدمن أو إيجنت)
app.post(
  '/api/labels/:labelId/assign-batch',
  requireAuth,
  async (req, res) => {
    try {
      const labelId = Number(req.params.labelId);
      const sessionIds = parseSessionIds(req.body);

      if (!labelId || !sessionIds.length) {
        return res.status(400).json({
          error: 'Valid labelId and sessionIds are required'
        });
      }

      await pool.query(
        `INSERT INTO conversation_label_assignments (session_id, label_id)
         SELECT unnest($1::text[]), $2
         ON CONFLICT (session_id, label_id) DO NOTHING`,
        [sessionIds, labelId]
      );

      broadcastLabelChanged(null);
      res.json({ success: true, count: sessionIds.length });
    } catch (err) {
      console.error('label assign-batch error:', err);
      res.status(500).json({
        error: 'Error assigning label',
        details: err.message
      });
    }
  }
);

// إزالة ليبل من مجموعة محادثات دفعة واحدة (أدمن أو إيجنت)
app.post(
  '/api/labels/:labelId/unassign-batch',
  requireAuth,
  async (req, res) => {
    try {
      const labelId = Number(req.params.labelId);
      const sessionIds = parseSessionIds(req.body);

      if (!labelId || !sessionIds.length) {
        return res.status(400).json({
          error: 'Valid labelId and sessionIds are required'
        });
      }

      await pool.query(
        `DELETE FROM conversation_label_assignments
         WHERE label_id = $1 AND session_id = ANY($2::text[])`,
        [labelId, sessionIds]
      );

      broadcastLabelChanged(null);
      res.json({ success: true, count: sessionIds.length });
    } catch (err) {
      console.error('label unassign-batch error:', err);
      res.status(500).json({
        error: 'Error removing label',
        details: err.message
      });
    }
  }
);

// إزالة ليبل من محادثة (أدمن أو إيجنت)
app.delete(
  '/api/conversations/:sessionId/labels/:labelId',
  requireAuth,
  async (req, res) => {
    try {
      const { sessionId, labelId } = req.params;

      await pool.query(
        `DELETE FROM conversation_label_assignments
         WHERE session_id = $1 AND label_id = $2`,
        [sessionId, Number(labelId)]
      );

      broadcastLabelChanged(sessionId);

      res.json({ success: true });
    } catch (err) {
      console.error('conversation label detach error:', err);
      res.status(500).json({
        error: 'Error detaching label',
        details: err.message
      });
    }
  }
);

// إرسال رسالة من الداشبورد
app.post('/api/send-message', requireAuth, requireConversationAccess(), async (req, res) => {
  if (getConversationChannel(req.body?.sessionId) === 'instagram') {
    try { return res.json(await instagramService.send({ ...req.body, agentName: req.user?.displayName || req.user?.username || 'Agent' })); }
    catch (error) { return res.status(error.status || 503).json({ error: error.message }); }
  }
  try {
    const agentName =
      req.user?.displayName ||
      req.user?.username ||
      'Agent';

    const {
  sessionId,
  message,
  replyTo,
  messageKind = "text",
  messageId = "",
  emoji = ""
} = req.body;

    if (!sessionId) {
  return res.status(400).json({
    error: 'sessionId is required'
  });
}

if (messageKind === "reaction") {
  if (!messageId) {
    return res.status(400).json({
      error: "messageId is required for reaction"
    });
  }

  // emoji مسموح تكون فاضية لإزالة الريأكت
  if (typeof emoji !== "string") {
    return res.status(400).json({
      error: "emoji must be a string"
    });
  }
}
else if (!message) {
  return res.status(400).json({
    error: 'message is required'
  });
}

    const sendWebhookUrl = getDashboardSendWebhookUrl(sessionId);

    if (!sendWebhookUrl) {
      return res.status(503).json({
        error: `${getConversationChannel(sessionId)} send webhook is not configured`
      });
    }

    const outboundPayload = {
      sessionId,
      message,
      replyTo,
      messageKind,
      messageId,
      emoji,
      agentName
    };

    if (getConversationChannel(sessionId) === 'messenger') {
      const response = await fetch(sendWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.INTERNAL_API_TOKEN || ''
        },
        body: JSON.stringify(outboundPayload)
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return res.status(response.status >= 400 && response.status < 500 ? response.status : 502).json({
          error: data.error || 'Messenger send workflow failed',
          details: data
        });
      }
      // Messenger canonical upsert already stored the authoritative Dashboard fields.
      // Do not run the legacy locator-based stamp after the canonical MID merge.
      return res.json({ success: true, channel: 'messenger', data });
    }

    // من غير await قصدًا: مانستناش رد n8n/واتساب الكامل (بياخد ثواني بسبب
    // الراوند تريب لـ WhatsApp API) قبل ما نرجع للداشبورد، عشان الرسالة تتبعت
    // على طول من غير ما تحس الشاشة إنها واقفة.
    fetch(sendWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.INTERNAL_API_TOKEN || ''
      },
      body: JSON.stringify(outboundPayload)
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          console.error('send-message n8n error:', data);
          return;
        }

        if (messageKind !== 'reaction') {
          stampLatestAgentMessage(
            sessionId,
            agentName,
            messageKind || 'text',
            message || '',
            replyTo
          ).catch((err) => {
            console.error('stampLatestAgentMessage error:', err);
          });
        }
      })
      .catch((err) => {
        console.error('send-message webhook error:', err);
      });

    res.json({
      success: true
    });
  } catch (err) {
    console.error('send-message error:', err);

    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

const DASHBOARD_ACTIONS = {
  memory_foam: 'ميموري فوم',
  foam: 'إسفنج',
  wholesale: 'جملة',
  regular: 'عادي'
};

// وقت آخر رسالة من العميل نفسه (نوعها user أو human حسب مين خزّنها)،
// مستخدم للتحقق من نافذة الـ 24 ساعة قبل السماح بأي مسار تلقائي بيبعت
// نص حر بدل تيمبليت معتمد
async function getLastCustomerMessageTime(sessionId) {
  const result = await pool.query(
    `SELECT created_at FROM chat_memory
     WHERE session_id = $1 AND message->>'type' IN ('user', 'human')
     ORDER BY id DESC LIMIT 1`,
    [sessionId]
  );

  return result.rows[0]?.created_at || null;
}

app.post('/api/dashboard-action', requireAuth, requireConversationAccess(), async (req, res) => {
  if (getConversationChannel(req.body?.sessionId) === 'instagram') return res.status(422).json({ error: 'Dashboard Actions are not supported for Instagram' });
  try {
    const { sessionId, actionId } = req.body || {};
    const actionLabel = DASHBOARD_ACTIONS[actionId];

    if (!sessionId || !actionLabel) {
      return res.status(400).json({
        error: 'Valid sessionId and actionId are required'
      });
    }

    const channel = getConversationChannel(sessionId);
    const lastCustomerMessageAt = await getLastCustomerMessageTime(sessionId);

    if (channel === 'whatsapp' && lastCustomerMessageAt) {
      const hoursPassed =
        (Date.now() - new Date(lastCustomerMessageAt).getTime()) / (1000 * 60 * 60);

      if (hoursPassed >= 24) {
        return res.status(400).json({
          error: 'مرّ أكثر من 24 ساعة على آخر رسالة من العميل — لازم تبعت تيمبليت بدل المسار التلقائي'
        });
      }
    }

    const agentName =
      req.user?.displayName ||
      req.user?.username ||
      'Agent';

    const sendWebhookUrl =
      channel === 'messenger'
        ? N8N_FB_SEND_WEBHOOK_URL
        : process.env.N8N_SEND_WEBHOOK_URL;

    if (!sendWebhookUrl) {
      return res.status(503).json({
        error: `${channel} dashboard action webhook is not configured`
      });
    }

    const response = await fetch(sendWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.INTERNAL_API_TOKEN || ''
      },
      body: JSON.stringify({
        sessionId,
        messageKind: 'dashboard_action',
        actionId,
        actionLabel,
        channel,
        agentName
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: 'Dashboard action failed in n8n',
        details: data
      });
    }

    res.json({
      success: true,
      actionId,
      actionLabel,
      data
    });
  } catch (err) {
    console.error('dashboard-action error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

app.post('/api/meta-purchase', requireAuth, requireConversationAccess(), async (req, res) => {
  if (getConversationChannel(req.body?.sessionId) === 'instagram') return res.status(422).json({ error: 'Meta Purchase is not enabled for Instagram' });
  try {
    const {
      sessionId,
      amount,
      currency = 'EGP',
      description = ''
    } = req.body || {};

    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedAmount = Number(amount);
    const normalizedCurrency = String(currency || 'EGP')
      .trim()
      .toUpperCase();

    const normalizedDescription = String(description || '').trim();

    if (!normalizedSessionId) {
      return res.status(400).json({
        error: 'sessionId is required'
      });
    }

    if (
      !Number.isFinite(normalizedAmount) ||
      normalizedAmount <= 0
    ) {
      return res.status(400).json({
        error: 'قيمة الطلب غير صحيحة'
      });
    }

    if (normalizedCurrency !== 'EGP') {
      return res.status(400).json({
        error: 'العملة المسموح بها هي EGP'
      });
    }

    const orderCode =
      `META-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const agentName =
      req.user?.displayName ||
      req.user?.username ||
      'Agent';

    const response = await fetch(
      process.env.N8N_SEND_WEBHOOK_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.INTERNAL_API_TOKEN || ''
        },
        body: JSON.stringify({
          sessionId: normalizedSessionId,
          messageKind: 'meta_purchase',
          actionId: 'meta_purchase',
          actionLabel: 'إنشاء طلب',
          amount: normalizedAmount,
          currency: normalizedCurrency,
          description: normalizedDescription,
          orderCode,
          agentName
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: 'فشل إرسال الطلب إلى n8n',
        details: data
      });
    }

    return res.json({
      success: true,
      orderCode,
      data
    });

  } catch (err) {
    console.error('meta-purchase error:', err);

    return res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

// تيمبليتات الواتس المعتمدة (بره فترة الـ 24 ساعة). templateName/language لازم
// تطابق بالظبط اسم التيمبليت المسجّل ومعتمد في WhatsApp Business Manager
const WHATSAPP_TEMPLATES = {
  followup: {
    label: 'متابعة',
    templateName: 'after_24h',
    language: 'ar'
  },
  order_confirm_ask: {
    label: 'تأكيد الطلب',
    templateName: 'order_confirm_ask',
    language: 'ar'
  }
};

app.get('/api/templates', requireAuth, (req, res) => {
  const templates = Object.entries(WHATSAPP_TEMPLATES).map(
    ([id, template]) => ({ id, label: template.label })
  );

  res.json({ templates });
});

app.post('/api/send-template', requireAuth, requireConversationAccess(), async (req, res) => {
  if (getConversationChannel(req.body?.sessionId) === 'instagram') return res.status(422).json({ error: 'WhatsApp Templates cannot be sent to Instagram' });
  try {
    const { sessionId, templateId } = req.body || {};
    const template = WHATSAPP_TEMPLATES[templateId];

    if (!sessionId || !template) {
      return res.status(400).json({
        error: 'Valid sessionId and templateId are required'
      });
    }

    const agentName =
      req.user?.displayName ||
      req.user?.username ||
      'Agent';

    const response = await fetch(process.env.N8N_SEND_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.INTERNAL_API_TOKEN || ''
      },
      body: JSON.stringify({
        sessionId,
        messageKind: 'dashboard_action',
        actionId: 'send_template',
        actionLabel: template.label,
        templateId,
        templateName: template.templateName,
        templateLanguage: template.language,
        agentName
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: 'Failed to send template via n8n',
        details: data
      });
    }

    res.json({
      success: true,
      templateId,
      data
    });
  } catch (err) {
    console.error('send-template error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

function buildOrderConfirmationPreview(orderData) {
  return [
    `أهلا أ.${orderData.name}، شكرا لشرائكم من المحراب 🌺`,
    'https://almehrab.org/',
    '',
    `هذه رسالة تأكيد لطلب سيادتكم رقم ${orderData.order}`,
    '',
    'الطلب:',
    orderData.items,
    '',
    'بيانات الشحن:',
    orderData.name,
    orderData.address,
    `ت/ ${orderData.contact}`,
    '',
    `إجمالي الطلب: ${orderData.total} شامل الشحن`,
    '',
    'يرجى مراجعة بيانات الطلب والشحن أعلاه:',
    '',
    'إذا كانت جميع البيانات صحيحة، اضغط على زر "تأكيد الطلب".',
    '',
    'وإذا كنت ترغب في إضافة أو تعديل أي بيانات، اضغط على زر "إضافة أو تعديل بيانات".',
    '',
    'ولكم جزيل الشكر 🌺'
  ].join('\n');
}

app.post(
  '/api/order-confirmation/context',
  requireAuth,
  requireConfirmationAccess,
  async (req, res) => {
    try {
      const phone = normalizeOrderConfirmationPhone(req.body?.phone);
      const currentOrder = String(req.body?.order || '').trim();

      if (!/^\d{8,15}$/.test(phone)) {
        return res.status(400).json({
          error: 'WhatsApp phone must be an international number containing 8 to 15 digits'
        });
      }

      if (req.user?.role === 'confirmation') {
        if (!ORDER_CONFIRMATION_LINK_SECRET) {
          return res.status(503).json({
            error: 'Order confirmation signed links are not configured'
          });
        }

        if (!verifyOrderConfirmationLinkSignature(req.body)) {
          return res.status(403).json({
            error: 'Invalid or modified order confirmation link'
          });
        }
      }

      if (!await authorizeConversationRequest(req, res, phone, { signedOrderContext: true })) return;

      const result = await pool.query(
        `SELECT id, created_at, message
         FROM chat_memory
         WHERE session_id = $1
           AND message->>'message_kind' = 'template'
           AND message->>'template_name' = 'order_confirmation'
         ORDER BY id DESC`,
        [phone]
      );

      const confirmations = result.rows.map((row) => {
        const message = row.message || {};
        const parameters = Array.isArray(message.template_parameters)
          ? message.template_parameters
          : Array.isArray(message.whatsapp_payload?.parameters)
            ? message.whatsapp_payload.parameters
            : [];

        return {
          messageId: row.id,
          timestamp: message.timestamp || row.created_at,
          order: String(parameters[1] || '').trim()
        };
      });
      const sameOrderConfirmation = currentOrder
        ? confirmations.find((item) => item.order === currentOrder) || null
        : null;
      const lastConfirmation = confirmations[0] || null;

      const accessToken = jwt.sign(
        {
          scope: 'order_confirmation_session',
          sessionId: phone,
          username: req.user.username,
          orderDigest: getOrderConfirmationPayloadDigest(req.body)
        },
        JWT_SECRET,
        { expiresIn: '30m' }
      );

      res.json({
        success: true,
        sessionId: phone,
        accessToken,
        hasPreviousConfirmation: confirmations.length > 0,
        lastConfirmation,
        sameOrderConfirmation
      });
    } catch (err) {
      console.error('order-confirmation/context error:', err);
      res.status(500).json({ error: 'Failed to prepare order confirmation context' });
    }
  }
);

app.post(
  '/api/send-order-confirmation',
  requireAuth,
  requireConfirmationAccess,
  async (req, res) => {
    try {
      const source = req.body || {};
      const orderData = normalizeOrderConfirmationData(source);
      const { phone } = orderData;

      const missingFields = Object.entries(orderData)
        .filter(([, value]) => !value)
        .map(([key]) => key);

      if (missingFields.length) {
        return res.status(400).json({
          error: `Missing required order data: ${missingFields.join(', ')}`
        });
      }

      if (!/^\d{8,15}$/.test(phone)) {
        return res.status(400).json({
          error: 'WhatsApp phone must be an international number containing 8 to 15 digits'
        });
      }


      if (req.user?.role === 'confirmation') {
        const grant = getTemporaryOrderConfirmationGrant(req);
        const validGrant = (
          grant?.scope === 'order_confirmation_session' &&
          grant?.username === req.user.username &&
          grant?.sessionId === phone &&
          grant?.orderDigest === getOrderConfirmationPayloadDigest(orderData)
        );

        if (!validGrant) {
          return res.status(403).json({
            error: 'A valid order confirmation context is required'
          });
        }

        if (!await authorizeConversationRequest(req, res, phone, { allowTemporary: true })) return;
      }

      const fieldLimits = {
        name: 300,
        order: 200,
        items: 5000,
        address: 2000,
        contact: 300,
        total: 300
      };

      const oversizedField = Object.entries(fieldLimits).find(
        ([key, limit]) => orderData[key].length > limit
      );

      if (oversizedField) {
        return res.status(400).json({
          error: `${oversizedField[0]} is too long`
        });
      }

      if (!process.env.N8N_SEND_WEBHOOK_URL) {
        return res.status(503).json({
          error: 'WhatsApp send workflow is not configured'
        });
      }

      const templateParameters = [
        orderData.name,
        orderData.order,
        orderData.items,
        orderData.address,
        orderData.contact,
        orderData.total,
        orderData.name
      ];
      const templatePreview = buildOrderConfirmationPreview(orderData);
      const agentName =
        req.user?.displayName || req.user?.username || 'Agent';

      const response = await fetch(process.env.N8N_SEND_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.INTERNAL_API_TOKEN || ''
        },
        body: JSON.stringify({
          sessionId: phone,
          messageKind: 'dashboard_action',
          actionId: 'send_template',
          actionLabel: 'تأكيد الطلب',
          templateId: 'order_confirmation',
          templateName: 'order_confirmation',
          templateLanguage: 'ar',
          templateMessageKind: 'template',
          templateParameters,
          templatePreview,
          agentName
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const workflowError =
          data.error || data.message || data.details?.message ||
          'Failed to send order confirmation via n8n';

        return res.status(502).json({
          error: workflowError,
          details: data
        });
      }

      res.json({
        success: true,
        sessionId: phone,
        templateName: 'order_confirmation',
        data
      });
    } catch (err) {
      console.error('send-order-confirmation error:', err);
      res.status(500).json({
        error: err.message || 'Internal server error'
      });
    }
  }
);

// جلب حالة AI
app.get('/api/ai-status/:sessionId', requireAuth, requireConversationAccess(), async (req, res) => {
  if (getConversationChannel(req.params.sessionId) === 'instagram') return res.json({ sessionId: req.params.sessionId, ai_enabled: false });
  const { sessionId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT ai_enabled
      FROM chat_sessions
      WHERE session_id = $1
      `,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return res.json({
        sessionId,
        ai_enabled: true
      });
    }

    res.json({
      sessionId,
      ai_enabled: result.rows[0].ai_enabled
    });
  } catch (err) {
    console.error('ai-status error:', err);
    res.status(500).json({
      error: 'Error fetching AI status',
      details: err.message
    });
  }
});

// تغيير حالة AI
app.post('/api/ai-status', requireAuth, requireConversationAccess(), async (req, res) => {
  if (getConversationChannel(req.body?.sessionId) === 'instagram') return res.status(422).json({ error: 'AI is not enabled for Instagram', ai_enabled: false });
  const { sessionId, ai_enabled } = req.body;

  if (!sessionId || typeof ai_enabled !== 'boolean') {
    return res.status(400).json({
      error: 'sessionId and ai_enabled are required'
    });
  }

  try {
    await pool.query(
      `
      INSERT INTO chat_sessions (session_id, ai_enabled)
      VALUES ($1, $2)
      ON CONFLICT (session_id)
      DO UPDATE SET ai_enabled = EXCLUDED.ai_enabled
      `,
      [sessionId, ai_enabled]
    );

    const payload = {
      type: 'ai_status_changed',
      sessionId,
      ai_enabled
    };

    broadcastDashboardEvent(payload);

    res.json({
      success: true,
      sessionId,
      ai_enabled
    });
  } catch (err) {
    console.error('ai-status update error:', err);
    res.status(500).json({
      error: 'Error updating AI status',
      details: err.message
    });
  }
});

// الردود المحفوظة
function broadcastSavedRepliesChanged() {
  const payload = { type: 'saved_replies_changed' };

  broadcastDashboardEvent(payload);
}

function mapSavedReplyRow(row, currentUser) {
  const isAdmin = currentUser?.role === 'admin';
  const currentUsername = currentUser?.username || '';

  return {
    id: row.id,
    text: row.text,
    isDefault: row.is_default,
    canRevert: row.is_default && row.text !== row.original_text,
    canDelete: isAdmin || (!row.is_default && row.created_by === currentUsername)
  };
}

app.get('/api/saved-replies', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, text, original_text, is_default, created_by
       FROM saved_replies
       ORDER BY id ASC`
    );

    res.json({
      replies: result.rows.map((row) => mapSavedReplyRow(row, req.user))
    });
  } catch (err) {
    console.error('saved-replies list error:', err);
    res.status(500).json({
      error: 'Error fetching saved replies',
      details: err.message
    });
  }
});

app.post('/api/saved-replies', requireAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();

    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const isAdmin = req.user?.role === 'admin';
    const createdBy = req.user?.username || '';

    const result = await pool.query(
      `INSERT INTO saved_replies (text, original_text, is_default, created_by)
       VALUES ($1, $1, $2, $3)
       RETURNING id, text, original_text, is_default, created_by`,
      [text, isAdmin, createdBy]
    );

    broadcastSavedRepliesChanged();

    res.json({
      success: true,
      reply: mapSavedReplyRow(result.rows[0], req.user)
    });
  } catch (err) {
    console.error('saved-replies create error:', err);
    res.status(500).json({
      error: 'Error creating saved reply',
      details: err.message
    });
  }
});

app.put('/api/saved-replies/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const text = String(req.body?.text || '').trim();

    if (!id || !text) {
      return res.status(400).json({
        error: 'Valid id and text are required'
      });
    }

    const isAdmin = req.user?.role === 'admin';

    // الأدمن بيعدّل النص الأصلي كمان، فيبقى هو المرجع الجديد للرجوع إليه
    const result = await pool.query(
      isAdmin
        ? `UPDATE saved_replies
           SET text = $1, original_text = $1, updated_at = now()
           WHERE id = $2
           RETURNING id, text, original_text, is_default, created_by`
        : `UPDATE saved_replies
           SET text = $1, updated_at = now()
           WHERE id = $2
           RETURNING id, text, original_text, is_default, created_by`,
      [text, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Saved reply not found' });
    }

    broadcastSavedRepliesChanged();

    res.json({
      success: true,
      reply: mapSavedReplyRow(result.rows[0], req.user)
    });
  } catch (err) {
    console.error('saved-replies update error:', err);
    res.status(500).json({
      error: 'Error updating saved reply',
      details: err.message
    });
  }
});

app.post('/api/saved-replies/:id/revert', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const result = await pool.query(
      `UPDATE saved_replies
       SET text = original_text, updated_at = now()
       WHERE id = $1 AND is_default = true
       RETURNING id, text, original_text, is_default, created_by`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'Default saved reply not found'
      });
    }

    broadcastSavedRepliesChanged();

    res.json({
      success: true,
      reply: mapSavedReplyRow(result.rows[0], req.user)
    });
  } catch (err) {
    console.error('saved-replies revert error:', err);
    res.status(500).json({
      error: 'Error reverting saved reply',
      details: err.message
    });
  }
});

app.delete('/api/saved-replies/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const isAdmin = req.user?.role === 'admin';
    const currentUsername = req.user?.username || '';

    // الأدمن يقدر يحذف أي رد، والإيجنت يقدر يحذف بس الردود اللي هو ضافها بنفسه
    const result = await pool.query(
      isAdmin
        ? `DELETE FROM saved_replies WHERE id = $1 RETURNING id`
        : `DELETE FROM saved_replies
           WHERE id = $1 AND is_default = false AND created_by = $2
           RETURNING id`,
      isAdmin ? [id] : [id, currentUsername]
    );

    if (!result.rows.length) {
      return res.status(403).json({
        error: 'Not allowed to delete this reply'
      });
    }

    broadcastSavedRepliesChanged();

    res.json({ success: true, id });
  } catch (err) {
    console.error('saved-replies delete error:', err);
    res.status(500).json({
      error: 'Error deleting saved reply',
      details: err.message
    });
  }
});

// الوسائط المحفوظة (فولدرات صور/فيديوهات جاهزة للإرسال)
function deleteMediaFilesBestEffort(filePath) {
  if (!filePath) return;

  fs.unlink(filePath, () => {});

  const thumbnailName = `${path.parse(filePath).name}.jpg`;
  const thumbnailPath = path.join(thumbnailsDir, thumbnailName);

  if (thumbnailPath !== filePath) {
    fs.unlink(thumbnailPath, () => {});
  }
}

// حدود واتساب الرسمية للوسائط: الصورة 5MB والفيديو 16MB. لو تعديت الحد،
// واتساب بيقبل طلب الإرسال لكن بيفشل يجيب الملف من اللينك بعد كدة بصمت،
// فالرسالة بتظهر "متبعتة" في الداشبورد بس ما توصلش للعميل.
const WHATSAPP_MEDIA_LIMITS = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024 };

// نص العرض الداخلي بس (الداشبورد وقايمة المحادثات) لما نبعت وسائط من
// غير كابشن — أبدًا ما بيتبعت لواتساب كـ caption فعلي
function mediaKindPlaceholderText(kind) {
  if (kind === 'video') return '🎥 فيديو';
  if (kind === 'image') return '📷 صورة';
  if (kind === 'audio') return '🎙️ رسالة صوتية';
  if (kind === 'sticker') return '🖼️ ملصق';
  if (kind === 'document') return '📄 ملف';
  return null;
}

async function sendDashboardMediaToChannel({
  sessionId,
  caption = '',
  messageKind,
  fileUrl,
  thumbnailUrl = '',
  agentName,
  source,
  replyTo = null
}) {
  const channel = getConversationChannel(sessionId);
  if (channel === 'instagram') {
    if (typeof replyTo === 'string') {
      try { replyTo = JSON.parse(replyTo); } catch { throw Object.assign(new Error('Invalid Instagram reply target'), { status: 400 }); }
    }
    const result = await instagramService.send({ sessionId, messageKind, mediaUrl: fileUrl, agentName, replyTo });
    if (caption) {
      try { await instagramService.send({ sessionId, message: caption, agentName }); }
      catch { throw Object.assign(new Error('Instagram attachment was sent, but its separate caption failed. Do not resend the attachment.'), { status: 502 }); }
    }
    return result;
  }
  const sendWebhookUrl = getDashboardSendWebhookUrl(sessionId);

  if (!sendWebhookUrl) {
    throw new Error(`${channel} send webhook is not configured`);
  }

  if (channel === 'messenger') {
    console.log('ATTACH/SAVED messenger media send start', {
      source,
      mediaKind: messageKind,
      fileUrl,
      timestamp: new Date().toISOString()
    });
    console.log('ATTACH/SAVED messenger media before n8n', {
      source,
      mediaKind: messageKind,
      fileUrl,
      timestamp: new Date().toISOString()
    });
  }

  const response = await fetch(sendWebhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.INTERNAL_API_TOKEN || ''
    },
    body: JSON.stringify({
      sessionId,
      message: caption || '',
      messageKind,
      mediaUrl: fileUrl,
      thumbnailUrl,
      agentName
    })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || 'Failed to send media via n8n');
    error.details = data;
    throw error;
  }

  if (channel === 'messenger') {
    console.log('ATTACH/SAVED messenger media after n8n', {
      source,
      mediaKind: messageKind,
      fileUrl,
      timestamp: new Date().toISOString()
    });
  }
  // Messenger media is finalized by the MID-based canonical upsert in
  // From Dashboard_FB. Keep the legacy stamp only for WhatsApp.
  if (channel !== 'messenger') {
    await stampLatestAgentMessage(
      sessionId,
      agentName,
      messageKind,
      fileUrl,
      null,
      caption ? null : mediaKindPlaceholderText(messageKind)
    );
  }

  return data;
}

async function sendSavedMediaToSession(item, sessionId, agentName, caption = '') {
  const channel = getConversationChannel(sessionId);
  const sizeLimit = channel === 'whatsapp'
    ? WHATSAPP_MEDIA_LIMITS[item.media_kind]
    : null;

  if (sizeLimit && item.file_path) {
    try {
      const stat = fs.statSync(item.file_path);

      if (stat.size > sizeLimit) {
        throw new Error(
          `حجم ${item.media_kind === 'video' ? 'الفيديو' : 'الصورة'} أكبر من الحد المسموح به في واتساب (${Math.round(sizeLimit / (1024 * 1024))}MB) — احذف الملف ده وارفعه تاني بحجم أصغر`
        );
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const useLocalPublicUrl =
    ((channel === 'messenger' && (item.media_kind === 'image' || item.media_kind === 'video')) ||
     (channel === 'instagram' && ['image', 'video', 'audio'].includes(item.media_kind))) &&
    item.file_path &&
    fs.existsSync(item.file_path);
  const dashboardBaseUrl = String(
    process.env.DASHBOARD_BASE_URL || 'https://wadashboardapi.almehrab.org'
  ).replace(/\/$/, '');
  const fileUrl = useLocalPublicUrl
    ? `${dashboardBaseUrl}/uploads/${encodeURIComponent(path.basename(item.file_path))}`
    : item.media_url;

  return sendDashboardMediaToChannel({
    sessionId,
    caption,
    messageKind: item.media_kind,
    fileUrl,
    thumbnailUrl: item.thumbnail_url || '',
    agentName,
    source: 'saved'
  });
}

// إرسال الوسائط المحفوظة بيشتغل كـ"جوب" في الخلفية على السيرفر نفسه، مش
// مربوط بطلب HTTP واحد بيستنى لحد ما كل العناصر تتبعت — عشان لو الأدمن/
// الإيجنت قفل الداشبورد أو خرج من التطبيق، الإرسال يكمل لوحده، والداشبورد
// يقدر يتابع التقدم (كام اتبعت من كام) عن طريق polling على الجوب لحد ما يخلص
const sendMediaJobs = new Map();
let sendMediaJobCounter = 0;

function startSendMediaJob(items, sessionId, agentName, caption = '', user) {
  const jobId = `job_${Date.now()}_${++sendMediaJobCounter}`;

  const job = {
    id: jobId,
    sessionId,
    total: items.length,
    sent: 0,
    failed: 0,
    failReasons: [],
    done: false,
    cancelled: false,
    createdAt: Date.now()
  };

  sendMediaJobs.set(jobId, job);

  // بنشيل الجوبات القديمة بعد شوية عشان الـ Map ما يكبرش على الفاضي
  setTimeout(() => sendMediaJobs.delete(jobId), 30 * 60 * 1000);

  (async () => {
    for (const item of items) {
      if (job.cancelled) break;

      try {
        if (!await canRequestAccessConversation({ user }, sessionId)) {
          throw new Error('Forbidden: conversation is not available for this user');
        }
        await sendSavedMediaToSession(item, sessionId, agentName, caption);
        job.sent++;
      } catch (err) {
        console.error('send media job item failed:', err);
        job.failed++;
        job.failReasons.push(err.message || 'فشل الإرسال');
      }
    }

    job.done = true;
  })();

  return job;
}

function serializeSendMediaJob(job) {
  return {
    id: job.id,
    total: job.total,
    sent: job.sent,
    failed: job.failed,
    failReasons: job.failReasons,
    done: job.done,
    cancelled: job.cancelled
  };
}

app.get('/api/saved-media-send-jobs/:jobId', requireAuth, async (req, res) => {
  const job = sendMediaJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!await authorizeConversationRequest(req, res, job.sessionId)) return;
  res.json(serializeSendMediaJob(job));
});

app.post('/api/saved-media-send-jobs/:jobId/cancel', requireAuth, async (req, res) => {
  const job = sendMediaJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!await authorizeConversationRequest(req, res, job.sessionId)) return;
  job.cancelled = true;
  res.json(serializeSendMediaJob(job));
});

// كل الفولدرات
app.get('/api/saved-media-folders', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        f.id,
        f.name,
        COUNT(i.id)::int AS item_count,
        (
          SELECT thumbnail_url FROM saved_media_items
          WHERE folder_id = f.id AND COALESCE(thumbnail_url, '') <> ''
          ORDER BY id ASC LIMIT 1
        ) AS cover_thumbnail
      FROM saved_media_folders f
      LEFT JOIN saved_media_items i ON i.folder_id = f.id
      GROUP BY f.id
      ORDER BY f.id ASC
    `);

    res.json({
      folders: result.rows,
      canManage: req.user?.role === 'admin'
    });
  } catch (err) {
    console.error('saved-media-folders list error:', err);
    res.status(500).json({
      error: 'Error fetching folders',
      details: err.message
    });
  }
});

// إنشاء فولدر (أدمن فقط)
app.post('/api/saved-media-folders', requireAuth, requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const createdBy = req.user?.username || '';

    const result = await pool.query(
      `INSERT INTO saved_media_folders (name, created_by)
       VALUES ($1, $2)
       RETURNING id, name`,
      [name, createdBy]
    );

    res.json({
      success: true,
      folder: { ...result.rows[0], item_count: 0, cover_thumbnail: null }
    });
  } catch (err) {
    console.error('saved-media-folders create error:', err);
    res.status(500).json({
      error: 'Error creating folder',
      details: err.message
    });
  }
});

// تعديل اسم فولدر (أدمن فقط)
app.put('/api/saved-media-folders/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();

    if (!id || !name) {
      return res.status(400).json({
        error: 'Valid id and name are required'
      });
    }

    const result = await pool.query(
      `UPDATE saved_media_folders SET name = $1 WHERE id = $2 RETURNING id, name`,
      [name, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    res.json({ success: true, folder: result.rows[0] });
  } catch (err) {
    console.error('saved-media-folders update error:', err);
    res.status(500).json({
      error: 'Error renaming folder',
      details: err.message
    });
  }
});

// حذف فولدر بكل محتوياته (أدمن فقط)
app.delete('/api/saved-media-folders/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const itemsResult = await pool.query(
      `SELECT file_path FROM saved_media_items WHERE folder_id = $1`,
      [id]
    );

    const result = await pool.query(
      `DELETE FROM saved_media_folders WHERE id = $1 RETURNING id`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    itemsResult.rows.forEach((row) => deleteMediaFilesBestEffort(row.file_path));

    res.json({ success: true, id });
  } catch (err) {
    console.error('saved-media-folders delete error:', err);
    res.status(500).json({
      error: 'Error deleting folder',
      details: err.message
    });
  }
});

// محتويات فولدر
app.get('/api/saved-media-folders/:id/items', requireAuth, async (req, res) => {
  try {
    const folderId = Number(req.params.id);

    if (!folderId) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const result = await pool.query(
      `SELECT id, media_kind, media_url, thumbnail_url, sort_order
       FROM saved_media_items
       WHERE folder_id = $1
       ORDER BY id ASC`,
      [folderId]
    );

    // مينفعش نرتب في الـ SQL بـ COALESCE(sort_order, id) — الـ id خام رقم
    // صغير (زي 12) والـ sort_order بعد أول ترتيب يدوي بيبقى رقم كبير (زي
    // 1500)، فالعناصر اللي لسه من غير sort_order كانت دايمًا بتفضل قبل أي
    // عنصر اتحرك، حتى لو المفروض يتحرك لفوق. بنحسب ترتيب موحّد بنفس المقياس
    // لكل العناصر هنا في الجافاسكريبت (زي ما بيحصل بالظبط في المعرض)
    const itemsWithOrder = result.rows.map((item, index) => ({
      ...item,
      sort_order:
        item.sort_order !== null && item.sort_order !== undefined
          ? Number(item.sort_order)
          : (index + 1) * 1000
    }));

    itemsWithOrder.sort((a, b) => a.sort_order - b.sort_order);

    res.json({
      items: itemsWithOrder,
      canManage: req.user?.role === 'admin'
    });
  } catch (err) {
    console.error('saved-media items list error:', err);
    res.status(500).json({
      error: 'Error fetching items',
      details: err.message
    });
  }
});

// رفع صورة/فيديو داخل فولدر (أدمن فقط)
app.post(
  '/api/saved-media-folders/:id/items',
  requireAuth,
  requireAdmin,
  upload.single('file'),
  async (req, res) => {
    try {
      const folderId = Number(req.params.id);

      if (!folderId) {
        return res.status(400).json({ error: 'Valid folder id is required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'file is required' });
      }

      const mimeType = String(req.file.mimetype || '');
      const mediaKind = mimeType.startsWith('video/') ? 'video' : 'image';

      // حدود واتساب الرسمية للوسائط: الصورة 5MB والفيديو 16MB. لو تعديت
      // الحد، واتساب بيقبل طلب الإرسال لكن بيفشل يجيب الملف من اللينك بعد
      // كدة بصمت، فالرسالة بتظهر "متبعتة" في الداشبورد بس ما توصلش للعميل.
      const WHATSAPP_MEDIA_LIMITS = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024 };
      const sizeLimit = WHATSAPP_MEDIA_LIMITS[mediaKind];

      let filePath = req.file.path;
      let fileName = req.file.filename;
      let fileSize = req.file.size;

      if (mediaKind === 'video' && sizeLimit && fileSize > sizeLimit) {
        try {
          const compressed = await compressVideoForWhatsApp(
            filePath,
            fileName,
            sizeLimit
          );

          fs.unlink(filePath, () => {});
          filePath = compressed.path;
          fileName = compressed.filename;
          fileSize = compressed.size;
        } catch (error) {
          console.error('Video compression failed:', error);
          fs.unlink(filePath, () => {});

          return res.status(500).json({
            error: 'تعذر ضغط الفيديو، حاول برفع نسخة أصغر.'
          });
        }

        if (fileSize > sizeLimit) {
          fs.unlink(filePath, () => {});

          return res.status(400).json({
            error: 'الفيديو طويل جدًا حتى بعد الضغط، حاول تقصيره أو رفع نسخة أصغر.'
          });
        }
      } else if (sizeLimit && fileSize > sizeLimit) {
        fs.unlink(filePath, () => {});

        return res.status(400).json({
          error: `حجم الصورة أكبر من الحد المسموح به في واتساب (${Math.round(sizeLimit / (1024 * 1024))}MB). قلل الحجم وحاول تاني.`
        });
      }

      const fileUrl = `https://${req.get('host')}/uploads/${fileName}`;
      let thumbnailUrl = '';

      // ffmpeg بيقدر ياخد أول فريم من الفيديو نفسه بنفس طريقة الصورة، فبيبقى
      // معانا صورة مصغّرة تعرّف الفيديو من غير ما نحمّله كامل
      try {
        const thumbnailName = await createImageThumbnail(
          filePath,
          fileName,
          mediaKind === 'video'
        );

        thumbnailUrl = `https://${req.get('host')}/uploads/thumbs/${thumbnailName}`;
      } catch (error) {
        console.error('Thumbnail creation failed:', error);
      }

      const createdBy = req.user?.username || '';

      const result = await pool.query(
        `INSERT INTO saved_media_items
           (folder_id, media_kind, media_url, thumbnail_url, file_path, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, media_kind, media_url, thumbnail_url`,
        [folderId, mediaKind, fileUrl, thumbnailUrl, filePath, createdBy]
      );

      res.json({ success: true, item: result.rows[0] });
    } catch (err) {
      console.error('saved-media item upload error:', err);
      res.status(500).json({
        error: 'Error uploading media',
        details: err.message
      });
    }
  }
);

// حذف عنصر واحد (أدمن فقط)
app.delete('/api/saved-media-items/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Valid id is required' });
    }

    const result = await pool.query(
      `DELETE FROM saved_media_items WHERE id = $1 RETURNING file_path`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Item not found' });
    }

    deleteMediaFilesBestEffort(result.rows[0].file_path);

    res.json({ success: true, id });
  } catch (err) {
    console.error('saved-media item delete error:', err);
    res.status(500).json({
      error: 'Error deleting item',
      details: err.message
    });
  }
});

// ترتيب عنصر يدويًا جوه نفس الفولدر (سحب وإفلات فوق عنصر تاني) — أدمن فقط،
// زي إضافة/حذف الوسائط المحفوظة
app.post('/api/saved-media-items/:id/reorder', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = Number(req.body?.order);

    if (!id || !Number.isFinite(order)) {
      return res.status(400).json({ error: 'Valid id and order are required' });
    }

    const result = await pool.query(
      `UPDATE saved_media_items SET sort_order = $1 WHERE id = $2 RETURNING id`,
      [order, id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('saved-media item reorder error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

// إرسال عنصر واحد للعميل (أدمن أو إيجنت)
app.post('/api/saved-media-items/:id/send', requireAuth, requireConversationAccess(), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { sessionId, caption = '' } = req.body || {};

    if (!id || !sessionId) {
      return res.status(400).json({
        error: 'Valid id and sessionId are required'
      });
    }

    const result = await pool.query(
      `SELECT id, media_kind, media_url, thumbnail_url, file_path
       FROM saved_media_items WHERE id = $1`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Saved media item not found' });
    }

    const agentName =
      req.user?.displayName || req.user?.username || 'Agent';

    const job = startSendMediaJob(result.rows, sessionId, agentName, caption, req.user);

    res.json({ success: true, jobId: job.id, total: job.total });
  } catch (err) {
    console.error('saved-media send error:', err);
    res.status(500).json({
      error: 'Error sending saved media',
      details: err.message
    });
  }
});

// إرسال مجموعة عناصر محددة للعميل دفعة واحدة (أدمن أو إيجنت)
app.post('/api/saved-media-items/send-batch', requireAuth, requireConversationAccess(), async (req, res) => {
  try {
    const { sessionId, itemIds } = req.body || {};
    const ids = Array.isArray(itemIds)
      ? itemIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    if (!sessionId || !ids.length) {
      return res.status(400).json({
        error: 'Valid sessionId and itemIds are required'
      });
    }

    const result = await pool.query(
      `SELECT id, media_kind, media_url, thumbnail_url, file_path
       FROM saved_media_items
       WHERE id = ANY($1::int[])
       ORDER BY id ASC`,
      [ids]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'No matching saved media found' });
    }

    const agentName =
      req.user?.displayName || req.user?.username || 'Agent';

    const job = startSendMediaJob(result.rows, sessionId, agentName, '', req.user);

    res.json({ success: true, jobId: job.id, total: job.total });
  } catch (err) {
    console.error('saved-media batch send error:', err);
    res.status(500).json({
      error: 'Error sending selected media',
      details: err.message
    });
  }
});

// إرسال كل محتوى الفولدر للعميل دفعة واحدة (أدمن أو إيجنت)
app.post('/api/saved-media-folders/:id/send', requireAuth, requireConversationAccess(), async (req, res) => {
  try {
    const folderId = Number(req.params.id);
    const { sessionId } = req.body || {};

    if (!folderId || !sessionId) {
      return res.status(400).json({
        error: 'Valid folder id and sessionId are required'
      });
    }

    const result = await pool.query(
      `SELECT id, media_kind, media_url, thumbnail_url, file_path
       FROM saved_media_items
       WHERE folder_id = $1
       ORDER BY id ASC`,
      [folderId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Folder is empty or not found' });
    }

    const agentName =
      req.user?.displayName || req.user?.username || 'Agent';

    const job = startSendMediaJob(result.rows, sessionId, agentName, '', req.user);

    res.json({ success: true, jobId: job.id, total: job.total });
  } catch (err) {
    console.error('saved-media folder send error:', err);
    res.status(500).json({
      error: 'Error sending folder media',
      details: err.message
    });
  }
});

app.post('/api/upload-media', upload.single('file'), async (req, res) => {
  const secret = req.headers['x-dashboard-secret'];

  if (secret !== process.env.DASHBOARD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }

  const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;
  let thumbnailUrl = "";

  if (String(req.file.mimetype || "").startsWith("image/")) {
    try {
      const thumbnailName = await createImageThumbnail(
        req.file.path,
        req.file.filename
      );

      thumbnailUrl =
        `https://${req.get('host')}/uploads/thumbs/${thumbnailName}`;
    } catch (error) {
      console.error('Thumbnail creation failed:', error);
    }
  }

  res.json({
    success: true,
    url: fileUrl,
    filename: req.file.filename,
    thumbnailUrl,
    thumbnail_url: thumbnailUrl
  });
});
app.post(
  '/api/send-media',
  requireAuth,
  requireConversationRole,
  upload.single('file'),
  requireConversationAccess(),
  async (req, res) => {
  let originalFilePath = null;
  let finalFilePath = null;

  try {
    const agentName =
      req.user?.displayName ||
      req.user?.username ||
      'Agent';

    const {
      sessionId,
      caption = "",
      messageKind = "image"
    } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId is required"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "file is required"
      });
    }

    originalFilePath = req.file.path;
    finalFilePath = originalFilePath;

    let finalFileName = req.file.filename;

    // تحويل تسجيل المتصفح إلى OGG/Opus المتوافق مع واتساب
    if (
      messageKind === "audio" &&
      getConversationChannel(sessionId) === "whatsapp"
    ) {
      const parsedName = path.parse(req.file.filename);

      finalFileName = `${parsedName.name}-converted.ogg`;
      finalFilePath = path.join(
        uploadsDir,
        finalFileName
      );

      await execFileAsync("ffmpeg", [
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        originalFilePath,
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-application",
        "voip",
        "-frame_duration",
        "20",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-avoid_negative_ts",
        "make_zero",
        "-f",
        "ogg",
        finalFilePath
      ]);

      const { stdout: audioProbeOutput } =
        await execFileAsync("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=codec_name,sample_rate,channels:format=duration",
          "-of",
          "json",
          finalFilePath
        ]);

      const audioProbe = JSON.parse(audioProbeOutput || "{}");
      const audioStream = audioProbe.streams?.[0] || {};
      const audioDuration = Number(audioProbe.format?.duration || 0);
      const audioFileSize = fs.statSync(finalFilePath).size;

      if (
        audioStream.codec_name !== "opus" ||
        audioStream.sample_rate !== "48000" ||
        Number(audioStream.channels) !== 1 ||
        !Number.isFinite(audioDuration) ||
        audioDuration <= 0 ||
        audioFileSize <= 0
      ) {
        throw new Error("Invalid WhatsApp audio after conversion");
      }

      // حذف النسخة الأصلية بعد نجاح التحويل
      if (
        originalFilePath !== finalFilePath &&
        fs.existsSync(originalFilePath)
      ) {
        fs.unlinkSync(originalFilePath);
      }
    }


    if (
      messageKind === "audio" &&
      getConversationChannel(sessionId) === "instagram" &&
      String(req.body.isVoiceRecording || "").toLowerCase() === "true"
    ) {
      const parsedName = path.parse(req.file.filename);
      finalFileName = `${parsedName.name}-instagram.mp3`;
      finalFilePath = path.join(uploadsDir, finalFileName);
      await execFileAsync("ffmpeg", ["-n", "-i", originalFilePath, "-map", "0:a:0",
        "-vn", "-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", finalFilePath]);
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name:format=duration", "-of", "json", finalFilePath]);
      const probe = JSON.parse(stdout || "{}");
      if (probe.streams?.[0]?.codec_name !== "mp3" || !(Number(probe.format?.duration) > 0) ||
          !(fs.statSync(finalFilePath).size > 0)) throw new Error("Invalid Instagram voice recording");
      // Preserve the uploaded original and any partial output; no deletion.
    }

    // Messenger rejects some browser-recorded WebM variants. Convert only
    // dashboard microphone recordings for Messenger; WhatsApp stays untouched.
    if (
      messageKind === "audio" &&
      getConversationChannel(sessionId) === "messenger" &&
      String(req.body.isVoiceRecording || "").toLowerCase() === "true"
    ) {
      const parsedName = path.parse(req.file.filename);

      finalFileName = `${parsedName.name}-converted.mp3`;
      finalFilePath = path.join(uploadsDir, finalFileName);

      await execFileAsync("ffmpeg", [
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        originalFilePath,
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "96k",
        "-ar",
        "44100",
        "-ac",
        "1",
        "-id3v2_version",
        "3",
        "-f",
        "mp3",
        finalFilePath
      ]);

      const { stdout: audioProbeOutput } =
        await execFileAsync("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=codec_name:format=duration",
          "-of",
          "json",
          finalFilePath
        ]);

      const audioProbe = JSON.parse(audioProbeOutput || "{}");
      const audioStream = audioProbe.streams?.[0] || {};
      const audioDuration = Number(audioProbe.format?.duration || 0);
      const audioFileSize = fs.statSync(finalFilePath).size;

      if (
        audioStream.codec_name !== "mp3" ||
        !Number.isFinite(audioDuration) ||
        audioDuration <= 0 ||
        audioFileSize <= 0
      ) {
        throw new Error("Invalid Messenger MP3 after conversion");
      }

      if (
        originalFilePath !== finalFilePath &&
        fs.existsSync(originalFilePath)
      ) {
        fs.unlinkSync(originalFilePath);
      }
    }

    const fileUrl =
      `https://${req.get("host")}/uploads/${finalFileName}`;
    let thumbnailUrl = "";

    if (messageKind === "image") {
      try {
        const thumbnailName = await createImageThumbnail(
          finalFilePath,
          finalFileName
        );

        thumbnailUrl =
          `https://${req.get("host")}/uploads/thumbs/${thumbnailName}`;
      } catch (thumbnailError) {
        console.error(
          "Thumbnail creation failed:",
          thumbnailError
        );
      }
    }

    if (getConversationChannel(sessionId) === 'instagram') {
      try { const data = await sendDashboardMediaToChannel({ sessionId, caption, messageKind, fileUrl, thumbnailUrl, agentName, source: 'attach', replyTo: req.body.replyTo || null });
        return res.json({ success: true, channel: 'instagram', url: fileUrl, data }); }
      catch (error) { return res.status(error.status || 503).json({ error: error.message }); }
    }
    const sendWebhookUrl = getDashboardSendWebhookUrl(sessionId);
    if (!sendWebhookUrl) {
      return res.status(503).json({
        error: `${getConversationChannel(sessionId)} send webhook is not configured`
      });
    }

    if (getConversationChannel(sessionId) === "messenger") {
      const messengerKind = messageKind;

      res.json({
        success: true,
        channel: "messenger",
        url: fileUrl,
        thumbnailUrl,
        messageKind: messengerKind,
        queued: true
      });

      sendDashboardMediaToChannel({
        sessionId,
        caption,
        messageKind: messengerKind,
        fileUrl,
        thumbnailUrl,
        agentName,
        source: 'attach'
      })
        .catch((err) => {
          console.error("Messenger background media send failed:", err);
        });

      return;
    }

    let data;
    try {
      data = await sendDashboardMediaToChannel({
        sessionId,
        caption,
        messageKind,
        fileUrl,
        thumbnailUrl,
        agentName,
        source: 'attach'
      });
    } catch (err) {
      return res.status(500).json({
        error: "Failed to send media via n8n",
        details: err.details || { error: err.message }
      });
    }

    res.json({
      success: true,
      url: fileUrl,
      thumbnailUrl,
      messageKind,
      data
    });

  } catch (err) {
    console.error("send-media error:", err);

    // حذف الملف المحوّل غير المكتمل إن وُجد
    if (
      getConversationChannel(req.body?.sessionId) !== "instagram" &&
      finalFilePath &&
      finalFilePath !== originalFilePath &&
      fs.existsSync(finalFilePath)
    ) {
      try {
        fs.unlinkSync(finalFilePath);
      } catch (cleanupError) {
        console.error(
          "Failed to remove converted audio:",
          cleanupError
        );
      }
    }

    res.status(500).json({
      error: "Internal server error",
      details: err.message
    });
  }
});
// ============ معرض جوجل درايف (content_team1) ============
// كل التخزين الفعلي في جوجل درايف — n8n هو الجسر الوحيد اللي بيتكلم مع
// درايف، والسيرفر بس بيمرر (proxy) الطلبات والملفات من غير ما يخزن حاجة
// عندنا، عدا رفعية عابرة في الذاكرة وقت الرفع بس.

async function callGalleryWebhook(payload) {
  const response = await fetch(process.env.N8N_GALLERY_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.INTERNAL_API_TOKEN || ''
    },
    body: JSON.stringify(payload)
  });

  return response;
}

let galleryDriveAccessToken = "";
let galleryDriveAccessTokenExpiresAt = 0;

async function getGalleryDriveAccessToken(forceRefresh = false) {
  if (
    !forceRefresh &&
    galleryDriveAccessToken &&
    Date.now() < galleryDriveAccessTokenExpiresAt
  ) {
    return galleryDriveAccessToken;
  }

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET || "";
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN || "";

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google Drive streaming credentials are not configured");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });

  const tokenData = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description ||
      tokenData.error ||
      "Failed to refresh Google Drive access token"
    );
  }

  galleryDriveAccessToken = tokenData.access_token;
  galleryDriveAccessTokenExpiresAt =
    Date.now() + Math.max(Number(tokenData.expires_in || 3600) - 60, 60) * 1000;

  return galleryDriveAccessToken;
}

async function fetchGalleryVideo(fileId, range, forceRefresh = false, signal) {
  const accessToken = await getGalleryDriveAccessToken(forceRefresh);
  const headers = {
    Authorization: `Bearer ${accessToken}`
  };

  if (range) headers.Range = range;

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers, signal }
  );

  if (response.status === 401 && !forceRefresh) {
    return fetchGalleryVideo(fileId, range, true, signal);
  }

  return response;
}

// بيمرر رد n8n (JSON) للمتصفح زي ما هو
async function proxyGalleryJson(req, res, payload) {
  try {
    const response = await callGalleryWebhook(payload);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: data.error || 'Gallery request failed in n8n'
      });
    }

    res.json(data);
  } catch (err) {
    console.error('gallery proxy error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
}

// بيمرر رد n8n (ملف بيناري) للمتصفح كـ stream من غير ما يتخزن على السيرفر
async function proxyGalleryBinary(req, res, payload) {
  try {
    const response = await callGalleryWebhook(payload);

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      return res.status(502).json({
        error: data.error || 'Gallery file request failed in n8n'
      });
    }

    const contentType = response.headers.get('content-type');
    const contentDisposition = response.headers.get('content-disposition');

    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) {
      res.setHeader('Content-Disposition', contentDisposition);
    }

    // نفس الصورة بترجع تتحمّل كل مرة تفتح فيها الفولدر من غير الكاش ده —
    // الملف مربوط بـ fileId ثابت، فمن الآمن نخلي المتصفح يحتفظ بنسخة منه
    if (payload.action === 'download_file') {
      res.setHeader('Cache-Control', 'private, max-age=86400');
    }

    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    console.error('gallery binary proxy error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
}

// بيرجع محتويات أي فولدر (فولدرات فرعية + ملفات) — بيستخدم نفس الـ n8n
// actions الموجودة أصلاً (list_folders/list_items) بس بيبعتلهم أي parentId،
// مش بس الفولدر الرئيسي، عشان يدعم تداخل فولدرات جوه بعض من غير أي تعديل
// في n8n. الفولدر الرئيسي عمقه غير محدود دلوقتي.
async function fetchGalleryFolderContents(folderId, { includeUploadFolder } = {}) {
  const [foldersRes, itemsRes] = await Promise.all([
    callGalleryWebhook({ action: 'list_folders', rootFolderId: folderId }),
    callGalleryWebhook({ action: 'list_items', folderId })
  ]);

  const foldersData = await foldersRes.json().catch(() => ({}));
  const itemsData = await itemsRes.json().catch(() => ({}));

  if (!foldersRes.ok) {
    throw new Error(foldersData.error || 'Failed to list folders via n8n');
  }
  if (!itemsRes.ok) {
    throw new Error(itemsData.error || 'Failed to list items via n8n');
  }

  const folders = Array.isArray(foldersData.folders) ? foldersData.folders : [];
  let items = Array.isArray(itemsData.items) ? itemsData.items : [];

  if (
    includeUploadFolder &&
    GALLERY_UPLOAD_FOLDER_ID &&
    GALLERY_UPLOAD_FOLDER_ID !== GALLERY_ROOT_FOLDER_ID &&
    !folders.some((f) => f.id === GALLERY_UPLOAD_FOLDER_ID)
  ) {
    folders.push({
      id: GALLERY_UPLOAD_FOLDER_ID,
      name: 'From Content Team',
      isOwnUploadFolder: true
    });
  }

  if (items.length) {
    items = await applyGalleryItemOrder(items);
  }

  return { folders, items };
}

// بيحط ترتيب مخصص (لو موجود) على كل ملف، وبيرتب القايمة بيه. الملفات اللي
// ما اتعرضتش عليها إعادة ترتيب لسه بتاخد ترتيب افتراضي بمسافات واسعة بينهم
// (1000, 2000, 3000...) عشان يبقى في مكان كافي نحط ترتيب كسري بينهم بعدين
async function applyGalleryItemOrder(items) {
  const result = await pool.query(
    `SELECT file_id, sort_order FROM gallery_file_order WHERE file_id = ANY($1::text[])`,
    [items.map((i) => i.id)]
  );

  const orderMap = new Map(result.rows.map((r) => [r.file_id, Number(r.sort_order)]));

  const withOrder = items.map((item, index) => ({
    ...item,
    order: orderMap.has(item.id) ? orderMap.get(item.id) : (index + 1) * 1000
  }));

  withOrder.sort((a, b) => a.order - b.order);
  return withOrder;
}

// جذر المعرض (الفولدر الرئيسي) + فولدر رفعيات content_team1 حتى لو كان
// برّه الفولدر الرئيسي تمامًا في درايف
app.get('/api/gallery/browse', requireAuth, requireGallery, async (req, res) => {
  try {
    const data = await fetchGalleryFolderContents(GALLERY_ROOT_FOLDER_ID, {
      includeUploadFolder: true
    });
    res.json(data);
  } catch (err) {
    console.error('gallery browse root error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

// محتويات أي فولدر تاني (على أي عمق)
app.get('/api/gallery/browse/:folderId', requireAuth, requireGallery, async (req, res) => {
  try {
    const data = await fetchGalleryFolderContents(req.params.folderId);
    res.json(data);
  } catch (err) {
    console.error('gallery browse folder error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

// تشغيل فيديو مباشرة من Google Drive مع دعم Range بدون تمرير الملف عبر n8n
app.get(
  '/api/gallery/items/:fileId/video-stream',
  requireAuth,
  requireGallery,
  async (req, res) => {
    const abortController = new AbortController();

    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      const range = req.headers.range || '';
      const response = await fetchGalleryVideo(
        req.params.fileId,
        range,
        false,
        abortController.signal
      );

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        return res.status(response.status || 502).json({
          error: data.error?.message || 'Failed to stream gallery video'
        });
      }

      const forwardedHeaders = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified'
      ];

      forwardedHeaders.forEach((headerName) => {
        const value = response.headers.get(headerName);
        if (value) res.setHeader(headerName, value);
      });

      if (req.query.download === '1') {
        const requestedFileName =
          path.basename(String(req.query.filename || 'video'));

        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(requestedFileName)}`
        );
      }

      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.status(response.status);

      Readable.fromWeb(response.body).pipe(res);
    } catch (err) {
      if (err.name === 'AbortError') return;

      console.error('gallery video stream error:', err);

      if (!res.headersSent) {
        res.status(502).json({
          error: 'Failed to stream gallery video',
          details: err.message
        });
      } else {
        res.destroy(err);
      }
    }
  }
);

// تحميل ملف واحد
app.get(
  '/api/gallery/items/:fileId/download',
  requireAuth,
  requireGallery,
  (req, res) => {
    proxyGalleryBinary(req, res, {
      action: 'download_file',
      fileId: req.params.fileId
    });
  }
);

// تحميل مجموعة ملفات محددة أو فولدر كامل كملف ZIP واحد
app.post('/api/gallery/download-zip', requireAuth, requireGallery, (req, res) => {
  const { fileIds, folderId } = req.body || {};

  const ids = Array.isArray(fileIds)
    ? fileIds.filter((id) => typeof id === 'string' && id.trim())
    : [];

  if (!ids.length && !folderId) {
    return res.status(400).json({
      error: 'Valid fileIds or folderId is required'
    });
  }

  proxyGalleryBinary(req, res, {
    action: 'download_zip',
    fileIds: ids,
    folderId: folderId || null
  });
});

// رفع ملف جديد. لو الطلب حدد targetFolderId (الفولدر المفتوح حاليًا في
// الداشبورد) بيترفع هناك، وإلا بيترفع في فولدر content_team1 الافتراضي.
// الحماية من إن content_team1 يرفع برّه فولدره بتبقى من واجهة الداشبورد
// نفسها (الزرار مش بيظهر إلا جوه فولدره)، مش تحقق إضافي هنا.
app.post(
  '/api/gallery/upload',
  requireAuth,
  requireGallery,
  uploadMemory.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'file is required' });
      }

      const targetFolderId =
        String(req.body?.targetFolderId || '').trim() ||
        GALLERY_UPLOAD_FOLDER_ID;

      const formData = new FormData();
      formData.append('action', 'upload_file');
      formData.append('targetFolderId', targetFolderId);
      formData.append('uploadedBy', req.user?.username || 'content_team1');
      formData.append(
        'file',
        new Blob([req.file.buffer], { type: req.file.mimetype }),
        req.file.originalname
      );

      const response = await fetch(process.env.N8N_GALLERY_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'x-api-key': process.env.INTERNAL_API_TOKEN || ''
        },
        body: formData
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return res.status(502).json({
          error: data.error || 'Failed to upload file via n8n'
        });
      }

      res.json({ success: true, file: data.file || data });
    } catch (err) {
      console.error('gallery upload error:', err);
      res.status(500).json({
        error: 'Internal server error',
        details: err.message
      });
    }
  }
);

// إنشاء فولدر جديد جوه الفولدر الرئيسي أو جوه أي فولدر تاني
async function createGalleryFolder(req, res, defaultParentFolderId) {
  try {
    const name = String(req.body?.name || '').trim();

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const parentFolderId =
      String(req.body?.parentFolderId || '').trim() || defaultParentFolderId;

    const response = await callGalleryWebhook({
      action: 'create_folder',
      parentFolderId,
      name
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: data.error || 'Failed to create folder via n8n'
      });
    }

    res.json({ success: true, folder: data.folder || data });
  } catch (err) {
    console.error('gallery create folder error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
}

app.post('/api/gallery/browse/folders', requireAuth, requireGallery, (req, res) => {
  createGalleryFolder(req, res, GALLERY_ROOT_FOLDER_ID);
});

app.post('/api/gallery/browse/:folderId/folders', requireAuth, requireGallery, (req, res) => {
  createGalleryFolder(req, res, req.params.folderId);
});

// حذف ملف (الواجهة بتظهر زرار الحذف بس جوه فولدر content_team1 نفسه)
app.delete('/api/gallery/items/:fileId', requireAuth, requireGallery, async (req, res) => {
  try {
    const response = await callGalleryWebhook({
      action: 'delete_file',
      fileId: req.params.fileId
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: data.error || 'Failed to delete file via n8n'
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('gallery delete error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

// نقل ملف أو فولدر لفولدر تاني (سحب وإفلات في الواجهة)
app.post('/api/gallery/items/:nodeId/move', requireAuth, requireGallery, async (req, res) => {
  try {
    // فاضي = نقل لجذر المعرض (الفولدر الرئيسي)
    const targetFolderId =
      String(req.body?.targetFolderId || '').trim() || GALLERY_ROOT_FOLDER_ID;

    const response = await callGalleryWebhook({
      action: 'move_file',
      nodeId: req.params.nodeId,
      targetFolderId
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(502).json({
        error: data.error || 'Failed to move item via n8n'
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('gallery move error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

// ترتيب ملف يدويًا جوه نفس الفولدر (سحب وإفلات فوق ملف تاني) — بنخزن
// الترتيب عندنا في بوستجرس، مش في درايف، فمحتاج صفر تعديل في n8n
app.post('/api/gallery/items/:fileId/reorder', requireAuth, requireGallery, async (req, res) => {
  try {
    const order = Number(req.body?.order);

    if (!Number.isFinite(order)) {
      return res.status(400).json({ error: 'Valid order is required' });
    }

    await pool.query(
      `INSERT INTO gallery_file_order (file_id, sort_order)
       VALUES ($1, $2)
       ON CONFLICT (file_id)
       DO UPDATE SET sort_order = $2, updated_at = now()`,
      [req.params.fileId, order]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('gallery reorder error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
