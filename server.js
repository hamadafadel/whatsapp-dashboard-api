const path = require('path');
const fs = require('fs');

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
app.use(cors());
app.use(express.json());
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

async function createImageThumbnail(filePath, fileName) {
  const thumbnailName = `${path.parse(fileName).name}.jpg`;
  const thumbnailPath = path.join(thumbnailsDir, thumbnailName);

  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    filePath,
    '-vf',
    "scale='min(480,iw)':-2",
    '-frames:v',
    '1',
    '-q:v',
    '5',
    thumbnailPath
  ]);

  return thumbnailName;
}

// الملفات المرفوعة أسماؤها فريدة، لذلك يمكن تخزينها بأمان لمدة سنة.
app.use(
  '/uploads',
  express.static(uploadsDir, {
    etag: true,
    lastModified: true,
    maxAge: '365d',
    immutable: true,
    setHeaders(res) {
      res.setHeader(
        'Cache-Control',
        'public, max-age=31536000, immutable'
      );
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
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '123456';
const DASHBOARD_AGENT1_USERNAME =
  process.env.DASHBOARD_AGENT1_USERNAME || '';
const DASHBOARD_AGENT1_PASSWORD =
  process.env.DASHBOARD_AGENT1_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@almehrab.org';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID keys not set — push notifications are disabled.');
}

function findDashboardAccount(username, password) {
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

  return accounts.find(
    (account) =>
      account.username === username &&
      account.password === password
  ) || null;
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

ensureSavedMediaTables().catch((err) => {
  console.error('Failed to ensure saved_media tables:', err);
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
}

ensureLabelsTables().catch((err) => {
  console.error('Failed to ensure labels tables:', err);
});

async function stampLatestAgentMessage(
  sessionId,
  agentName,
  messageKind = 'text',
  messageLocator = '',
  replyTo = null
) {
  if (!sessionId || !agentName) return;

  // لو الرسالة دي رد على رسالة تانية، بنثبّت الـ reply_to على نفس السطر
  // عشان يفضل ظاهر بعد أي إعادة تحميل، حتى لو الـ n8n نفسه ما بيحفظوش
  const hasReplyTo = Boolean(replyTo && replyTo.content);

  await pool.query(
    hasReplyTo
      ? `
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
        SET message = jsonb_set(
          jsonb_set(
            cm.message,
            '{agent_name}',
            to_jsonb($2::text),
            true
          ),
          '{reply_to}',
          $5::jsonb,
          true
        )
        FROM target
        WHERE cm.id = target.id
        `
      : `
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
        SET message = jsonb_set(
          cm.message,
          '{agent_name}',
          to_jsonb($2::text),
          true
        )
        FROM target
        WHERE cm.id = target.id
        `,
    hasReplyTo
      ? [sessionId, agentName, messageKind, messageLocator, JSON.stringify(replyTo)]
      : [sessionId, agentName, messageKind, messageLocator]
  );

  const payload = {
    type: 'refresh_messages',
    sessionId,
    agentName
  };

  for (const client of clients) {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
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

    const result = await pool.query(
      `
      SELECT
        latest.session_id,
        latest.content,
        latest.type,
        names.customer_name,
        latest.id,
        COALESCE(unread.unread_count, 0) AS unread_count,
        COALESCE(labels_agg.labels, '[]') AS labels,
        COALESCE(sess.hidden, false) AS hidden
      FROM (
        SELECT DISTINCT ON (session_id)
          session_id,
          message->>'content' AS content,
          message->>'type' AS type,
          id
        FROM chat_memory
        ORDER BY session_id, id DESC
      ) latest
      LEFT JOIN (
        SELECT DISTINCT ON (session_id)
          session_id,
          message->>'customer_name' AS customer_name
        FROM chat_memory
        WHERE COALESCE(message->>'customer_name', '') <> ''
        ORDER BY session_id, id DESC
      ) names
      ON latest.session_id = names.session_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS unread_count
        FROM chat_memory cm
        WHERE cm.session_id = latest.session_id
          AND cm.message->>'type' = 'user'
          AND cm.id > COALESCE(
            (SELECT cs.last_read_message_id FROM chat_sessions cs WHERE cs.session_id = latest.session_id),
            0
          )
      ) unread ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object('id', cl.id, 'name', cl.name, 'color', cl.color)
          ORDER BY cl.id
        ) AS labels
        FROM conversation_label_assignments cla
        JOIN conversation_labels cl ON cl.id = cla.label_id
        WHERE cla.session_id = latest.session_id
      ) labels_agg ON true
      LEFT JOIN chat_sessions sess ON sess.session_id = latest.session_id
      WHERE COALESCE(sess.hidden, false) = $1
      ORDER BY latest.id DESC
      `,
      [wantHidden]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Conversations error:', err);
    res.status(500).json({
      error: 'Error fetching conversations',
      details: err.message
    });
  }
});

// رسائل محادثة واحدة
app.get('/api/messages/:sessionId', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const limit = Math.min(
    Math.max(Number(req.query.limit || 100), 1),
    100
  );
  const beforeId = req.query.beforeId
    ? Number(req.query.beforeId)
    : null;

  try {
    const [result, countResult] = await Promise.all([
      pool.query(
      `
      SELECT * FROM (
        SELECT
          id,
          session_id,
          created_at,
          message,
          message->>'type' AS type,
          message->>'content' AS content,
          message->>'message_kind' AS message_kind
        FROM chat_memory
        WHERE session_id = $1
          AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC
        LIMIT $3
      ) page
      ORDER BY id ASC
      `,
      [sessionId, beforeId, limit + 1]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM chat_memory WHERE session_id = $1`,
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
      nextBeforeId: pageRows[0]?.id || null
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
app.get('/api/media/:sessionId', requireAuth, async (req, res) => {
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

// SSE test
app.get('/api/test-event', (req, res) => {
  const payload = {
    message: 'Hello from server 🔥',
    time: new Date().toISOString()
  };

  for (const client of clients) {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  res.json({ sent: true });
});

// SSE stream
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ connected: true })}\n\n`);

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
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

  for (const client of clients) {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  console.log(
    `push-update received: type=${payload.type} messageType=${payload.messageType} sessionId=${payload.sessionId}`
  );

  // رسالة عميل جديدة فعلية: n8n بيبعتها كـ type=new_message مع messageType=user
  // (مش user_message زي ما كنا مفترضين قبل كده — ده كان سبب عدم ظهور الإشعارات خالص)
  if (
    payload.type === 'new_message' &&
    payload.sessionId &&
    payload.messageType === 'user'
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

async function sendPushToAllSubscriptions(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('sendPushToAllSubscriptions: VAPID keys missing, skipping');
    return;
  }

  const result = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions'
  );

  console.log(
    `sendPushToAllSubscriptions: found ${result.rows.length} subscription(s)`
  );

  const body = JSON.stringify(payload);

  await Promise.all(
    result.rows.map(async (row) => {
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
  console.log(`sendNewMessagePush: triggered for session ${sessionId}`);

  const customerName = (await getCustomerNameForSession(sessionId)) || 'عميل';
  const body = buildPushBodyText(payload);

  await sendPushToAllSubscriptions({
    title: customerName,
    body,
    sessionId,
    url: '/'
  });
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
       DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
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

      for (const client of clients) {
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
      }

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

      for (const client of clients) {
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
      }

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

  for (const client of clients) {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function parseSessionIds(body) {
  const ids = Array.isArray(body?.sessionIds) ? body.sessionIds : [];
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

// إخفاء مجموعة محادثات من القايمة الرئيسية
app.post('/api/conversations/hide', requireAuth, async (req, res) => {
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
app.post('/api/conversations/unhide', requireAuth, async (req, res) => {
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
        for (const client of clients) {
          client.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
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

  for (const client of clients) {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
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
app.post('/api/send-message', requireAuth, async (req, res) => {
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

    const response = await fetch(process.env.N8N_SEND_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.INTERNAL_API_TOKEN || ''
      },
      body: JSON.stringify({
  sessionId,
  message,
  replyTo,
  messageKind,
  messageId,
  emoji,
  agentName
})
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        error: 'Failed to send message via n8n',
        details: data
      });
    }

    if (messageKind !== 'reaction') {
      // من غير await قصدًا: تثبيت اسم المرسل والرد المقتبس مش لازم المستخدم
      // ينتظره، وده كان بياخد جولة Postgres إضافية قبل ما الرد يرجع للداشبورد
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

    res.json({
      success: true,
      data
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

app.post('/api/dashboard-action', requireAuth, async (req, res) => {
  try {
    const { sessionId, actionId } = req.body || {};
    const actionLabel = DASHBOARD_ACTIONS[actionId];

    if (!sessionId || !actionLabel) {
      return res.status(400).json({
        error: 'Valid sessionId and actionId are required'
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
        actionId,
        actionLabel,
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

// جلب حالة AI
app.get('/api/ai-status/:sessionId', requireAuth, async (req, res) => {
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
app.post('/api/ai-status', requireAuth, async (req, res) => {
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

    for (const client of clients) {
      client.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

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

  for (const client of clients) {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
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

async function sendSavedMediaToSession(item, sessionId, agentName, caption = '') {
  // بدون نص ثابت هنا، بعض ورش n8n بتحاول تولّد كابشن تلقائي من محتوى
  // الصورة نفسها (زي OCR)، وده اللي كان بيظهر كنص غريب تحت آخر رسالة
  // في قايمة المحادثات. النص الثابت ده بيمنع أي توليد تلقائي.
  const outgoingMessage =
    caption ||
    (item.media_kind === 'video' ? '🎥 فيديو' : '📷 صورة');

  const response = await fetch(process.env.N8N_SEND_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.INTERNAL_API_TOKEN || ''
    },
    body: JSON.stringify({
      sessionId,
      message: outgoingMessage,
      messageKind: item.media_kind,
      mediaUrl: item.media_url,
      thumbnailUrl: item.thumbnail_url || '',
      agentName
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Failed to send media via n8n');
  }

  await stampLatestAgentMessage(
    sessionId,
    agentName,
    item.media_kind,
    item.media_url
  );

  return data;
}

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
      `SELECT id, media_kind, media_url, thumbnail_url
       FROM saved_media_items
       WHERE folder_id = $1
       ORDER BY id ASC`,
      [folderId]
    );

    res.json({
      items: result.rows,
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

      const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;
      let thumbnailUrl = '';

      if (mediaKind === 'image') {
        try {
          const thumbnailName = await createImageThumbnail(
            req.file.path,
            req.file.filename
          );

          thumbnailUrl = `https://${req.get('host')}/uploads/thumbs/${thumbnailName}`;
        } catch (error) {
          console.error('Thumbnail creation failed:', error);
        }
      }

      const createdBy = req.user?.username || '';

      const result = await pool.query(
        `INSERT INTO saved_media_items
           (folder_id, media_kind, media_url, thumbnail_url, file_path, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, media_kind, media_url, thumbnail_url`,
        [folderId, mediaKind, fileUrl, thumbnailUrl, req.file.path, createdBy]
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

// إرسال عنصر واحد للعميل (أدمن أو إيجنت)
app.post('/api/saved-media-items/:id/send', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { sessionId, caption = '' } = req.body || {};

    if (!id || !sessionId) {
      return res.status(400).json({
        error: 'Valid id and sessionId are required'
      });
    }

    const result = await pool.query(
      `SELECT id, media_kind, media_url, thumbnail_url
       FROM saved_media_items WHERE id = $1`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Saved media item not found' });
    }

    const agentName =
      req.user?.displayName || req.user?.username || 'Agent';

    const data = await sendSavedMediaToSession(
      result.rows[0],
      sessionId,
      agentName,
      caption
    );

    res.json({ success: true, data });
  } catch (err) {
    console.error('saved-media send error:', err);
    res.status(500).json({
      error: 'Error sending saved media',
      details: err.message
    });
  }
});

// إرسال مجموعة عناصر محددة للعميل دفعة واحدة (أدمن أو إيجنت)
app.post('/api/saved-media-items/send-batch', requireAuth, async (req, res) => {
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
      `SELECT id, media_kind, media_url, thumbnail_url
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

    let sent = 0;
    let failed = 0;

    for (const item of result.rows) {
      try {
        await sendSavedMediaToSession(item, sessionId, agentName, '');
        sent++;
      } catch (err) {
        console.error('batch send item failed:', err);
        failed++;
      }
    }

    res.json({
      success: true,
      sent,
      failed,
      total: result.rows.length
    });
  } catch (err) {
    console.error('saved-media batch send error:', err);
    res.status(500).json({
      error: 'Error sending selected media',
      details: err.message
    });
  }
});

// إرسال كل محتوى الفولدر للعميل دفعة واحدة (أدمن أو إيجنت)
app.post('/api/saved-media-folders/:id/send', requireAuth, async (req, res) => {
  try {
    const folderId = Number(req.params.id);
    const { sessionId } = req.body || {};

    if (!folderId || !sessionId) {
      return res.status(400).json({
        error: 'Valid folder id and sessionId are required'
      });
    }

    const result = await pool.query(
      `SELECT id, media_kind, media_url, thumbnail_url
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

    let sent = 0;
    let failed = 0;

    for (const item of result.rows) {
      try {
        await sendSavedMediaToSession(item, sessionId, agentName, '');
        sent++;
      } catch (err) {
        console.error('bulk send item failed:', err);
        failed++;
      }
    }

    res.json({
      success: true,
      sent,
      failed,
      total: result.rows.length
    });
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
  upload.single('file'),
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
    if (messageKind === "audio") {
      const parsedName = path.parse(req.file.filename);

      finalFileName = `${parsedName.name}-converted.ogg`;
      finalFilePath = path.join(
        uploadsDir,
        finalFileName
      );

      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        originalFilePath,

        "-vn",

        "-c:a",
        "libopus",

        "-b:a",
        "32k",

        "-application",
        "voip",

        "-ar",
        "48000",

        "-ac",
        "1",

        finalFilePath
      ]);

      // حذف النسخة الأصلية بعد نجاح التحويل
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

    const response = await fetch(
      process.env.N8N_SEND_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-api-key":
            process.env.INTERNAL_API_TOKEN || ""
        },

        body: JSON.stringify({
          sessionId,
          message: caption,
          messageKind,
          mediaUrl: fileUrl,
          thumbnailUrl,
          agentName
        })
      }
    );

    const data =
      await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        error: "Failed to send media via n8n",
        details: data
      });
    }

    await stampLatestAgentMessage(
      sessionId,
      agentName,
      messageKind,
      fileUrl
    );

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
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
