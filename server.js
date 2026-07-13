const path = require('path');
const fs = require('fs');

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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

async function stampLatestAgentMessage(
  sessionId,
  agentName,
  messageKind = 'text',
  messageLocator = ''
) {
  if (!sessionId || !agentName) return;

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
    SET message = jsonb_set(
      cm.message,
      '{agent_name}',
      to_jsonb($2::text),
      true
    )
    FROM target
    WHERE cm.id = target.id
    `,
    [sessionId, agentName, messageKind, messageLocator]
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
    const result = await pool.query(`
      SELECT
        latest.session_id,
        latest.content,
        latest.type,
        names.customer_name,
        latest.id
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
      ORDER BY latest.id DESC
    `);

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

  res.json({ sent: true });
});

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
      await stampLatestAgentMessage(
        sessionId,
        agentName,
        messageKind || 'text',
        message || ''
      );
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
