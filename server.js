const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 بيانات قاعدة البيانات (حط بياناتك هنا)
const pool = new Pool({
  host: 'postgresql',
  port: 5432,
  database: 'n8n',
  user: 'postgres',
  password: 'II2hY4awfMwBP2AJgVxXsDaFUDUw2fUJotrgkYdHOrv73AZU4UQB6Z4K2WunbNPf',
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
    console.error(err);
    res.status(500).send('Error fetching conversations');
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
    console.error(err);
    res.status(500).send('Error fetching messages');
  }
});

// 🟢 تشغيل السيرفر
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});