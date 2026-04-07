const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
const clients = new Set();

// 🔥 بيانات قاعدة البيانات (حط بياناتك هنا)
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// 🟢 اختبار السيرفر
app.get('/', (req, res) => {
  res.send('API is working 🚀');
});

// 🟢 كل المحادثات
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (session_id)
        session_id,
        message->>'content' AS content,
        message->>'type' AS type,
        id
      FROM chat_memory
      ORDER BY session_id, id DESC
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

// 🟢 رسائل محادثة واحدة
app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        session_id,
        message->>'type' AS type,
        message->>'content' AS content
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

// 🟢 تشغيل السيرفر
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

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

const PORT = process.env.PORT || 3000;

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

    // ✅ مهم جدًا
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
