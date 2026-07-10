const path = require('path');
const fs = require('fs');

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use('/uploads', express.static(uploadsDir));
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
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
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

// اختبار السيرفر
app.get('/', (req, res) => {
  res.send('API is working 🚀');
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (
      username !== DASHBOARD_USERNAME ||
      password !== DASHBOARD_PASSWORD
    ) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    const token = jwt.sign(
      {
        username
      },
      JWT_SECRET,
      {
        expiresIn: '30d'
      }
    );

    res.json({
      success: true,
      token
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
  const limit = Math.min(Number(req.query.limit || 50), 200);

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM (
        SELECT
          id,
          session_id,
          message,
          message->>'type' AS type,
          message->>'content' AS content,
          message->>'message_kind' AS message_kind
        FROM chat_memory
        WHERE session_id = $1
        ORDER BY id DESC
        LIMIT $2
      ) latest
      ORDER BY id ASC
      `,
      [sessionId, limit]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Messages error:', err);
    res.status(500).json({
      error: 'Error fetching messages',
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
  if (!messageId || !emoji) {
    return res.status(400).json({
      error: 'messageId and emoji are required for reaction'
    });
  }
} else if (!message) {
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
  emoji
})
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        error: 'Failed to send message via n8n',
        details: data
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

app.post('/api/upload-media', upload.single('file'), (req, res) => {
  const secret = req.headers['x-dashboard-secret'];

  if (secret !== process.env.DASHBOARD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }

  const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;

  res.json({
    success: true,
    url: fileUrl,
    filename: req.file.filename
  });
});
app.post('/api/send-media', upload.single('file'), async (req, res) => {
  try {
    const { sessionId, caption = '', messageKind = 'image' } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const fileUrl = `https://${req.get('host')}/uploads/${req.file.filename}`;

    const response = await fetch(process.env.N8N_SEND_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.INTERNAL_API_TOKEN || ''
      },
      body: JSON.stringify({
        sessionId,
        message: caption,
        messageKind,
        mediaUrl: fileUrl
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        error: 'Failed to send media via n8n',
        details: data
      });
    }

    res.json({
      success: true,
      url: fileUrl,
      data
    });
  } catch (err) {
    console.error('send-media error:', err);
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
