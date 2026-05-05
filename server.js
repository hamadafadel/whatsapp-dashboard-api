const path = require('path');
const fs = require('fs');

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use('/uploads', express.static(uploadsDir));
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

// كل المحادثات
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM (
        SELECT DISTINCT ON (session_id)
          session_id,
          message->>'content' AS content,
          message->>'type' AS type,
          id
        FROM chat_memory
        ORDER BY session_id, id DESC
      ) latest
      ORDER BY id DESC
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
app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
  id,
  session_id,
  message,
  message->>'type' AS type,
  message->>'content' AS content,
  message->>'message_kind' AS message_kind
FROM chat_memory
WHERE session_id = $1
ORDER BY id ASC
      `,
      [sessionId]
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
app.get('/api/events', (req, res) => {
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
app.post('/api/send-message', async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({
        error: 'sessionId and message are required'
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
        message
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
app.get('/api/ai-status/:sessionId', async (req, res) => {
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
app.post('/api/ai-status', async (req, res) => {
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
