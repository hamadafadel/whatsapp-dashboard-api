const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// Run the actual server/route code with all I/O replaced. No real DB, HTTP,
// uploads, ffmpeg, timers, or listening socket can be used by this fixture.
async function fixture() {
  const routes = new Map();
  const calls = { sql: [], fetch: [], uploads: 0, ffmpeg: 0, ffmpegArgs: [] };
  const states = new Map();
  const tokens = new Map();
  const env = {
    DASHBOARD_USERNAME: 'test_admin', DASHBOARD_PASSWORD: 'test-only',
    DASHBOARD_AGENT1_USERNAME: 'test_agent', DASHBOARD_AGENT1_PASSWORD: 'test-only',
    DASHBOARD_CONFIRMATION_USERNAME: 'test_confirmation', DASHBOARD_CONFIRMATION_PASSWORD: 'test-only',
    DASHBOARD_GALLERY_USERNAME: 'test_gallery', DASHBOARD_GALLERY_PASSWORD: 'test-only',
    JWT_SECRET: 'unit-test-only-secret', ORDER_CONFIRMATION_LINK_SECRET: 'unit-test-link-secret',
    DASHBOARD_SECRET: 'unit-test-dashboard-secret',
    N8N_SEND_WEBHOOK_URL: 'https://n8n.example.invalid/whatsapp',
    N8N_FB_SEND_WEBHOOK_URL: 'https://n8n.example.invalid/messenger',
    N8N_MESSENGER_WEBHOOK_URL: 'https://n8n.example.invalid/incoming-messenger',
    META_APP_SECRET: 'unit-test-meta-secret'
  };
  const jwt = {
    sign(claims, secret, options = {}) {
      const token = `test-token-${tokens.size}`;
      const lifetime = options.expiresIn === '30m' ? 1800 : 30 * 86400;
      tokens.set(token, { ...claims, exp: Math.floor(Date.now() / 1000) + lifetime });
      return token;
    },
    verify(token) {
      const claims = tokens.get(token);
      if (!claims || claims.exp <= Date.now() / 1000) throw new Error('Invalid test token');
      return { ...claims };
    }
  };
  const app = { use() {}, listen() {} };
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers);
  }
  const express = () => app;
  express.json = express.static = () => (req, res, next) => next();
  const multer = () => ({ single: () => (req, res, next) => { calls.uploads++; next(); } });
  multer.diskStorage = multer.memoryStorage = () => ({});
  let lookupError = false;
  let lookupHook = null;
  let fetchHook = null;
  let savedMediaItems = [{ id: 1, media_kind: 'image',
    media_url: 'https://media.example.invalid/test.png', thumbnail_url: '', file_path: '' }];
  const pool = {
    async query(sql, values = []) {
      calls.sql.push({ sql, values });
      if (sql.includes('AS globally_hidden')) {
        if (lookupError) throw Object.assign(new Error('Synthetic outage'), { code: 'TEST_OUTAGE' });
        if (lookupHook) await lookupHook(values[0]);
        const state = states.get(values[0]) || {};
        return { rows: [{ globally_hidden: !!state.hidden, is_confirmation: !!state.confirmation,
          hidden_for_usernames: state.hiddenFor || [] }] };
      }
      if (/FROM saved_media_items/.test(sql)) {
        const rows = /WHERE id = \$1/.test(sql) ? savedMediaItems.filter(item => item.id === values[0])
          : /WHERE id = ANY/.test(sql) ? savedMediaItems.filter(item => values[0].includes(item.id))
          : savedMediaItems;
        return { rows };
      }
      if (/SELECT created_at FROM chat_memory/.test(sql)) return { rows: [{ created_at: new Date() }] };
      if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total: 0 }] };
      if (/SELECT ai_enabled/.test(sql)) return { rows: [{ ai_enabled: true }] };
      return { rows: [] };
    }
  };
  pool.connect = async () => ({ query: pool.query.bind(pool), release() {} });
  const mocks = {
    express, pg: { Pool: function () { return pool; } }, cors: () => () => {}, multer,
    jsonwebtoken: jwt, bcryptjs: {}, 'web-push': {},
    fs: { existsSync: () => true, mkdirSync() {}, statSync: () => ({ size: 100 }),
      unlink(p, cb) { cb?.(); }, unlinkSync() {}, readdirSync: () => [] },
    child_process: { execFile(command, args, callback) {
      calls.ffmpeg++; calls.ffmpegArgs.push({ command, args });
      const codec = args.includes('stream=codec_name:format=duration') ? 'mp3' : 'opus';
      callback(null, { stdout: JSON.stringify({ streams: [{ codec_name: codec, sample_rate: '48000', channels: 1 }], format: { duration: 2 } }), stderr: '' });
    } }
  };
  const context = {
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (['path', 'crypto', 'stream', 'util'].includes(name)) return require(name);
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env }, __dirname: path.resolve(__dirname, '..'), Buffer,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    fetch: async (url, options = {}) => {
      calls.fetch.push({ url, options });
      if (fetchHook) await fetchHook(url, options);
      return { ok: true, status: 200, json: async () => ({ success: true,
        message_id: 'TEST_FB_MID', messages: [{ id: 'TEST_WA_MID' }] }) };
    },
    module: { exports: {} }, URL, Blob, FormData
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports = { clients, broadcastDashboardEvent, sendMediaJobs, startSendMediaJob, getOrderConfirmationCanonicalPayload };', context);
  await new Promise(setImmediate);
  calls.sql.length = 0;
  const api = context.module.exports;
  const users = {
    admin: { username: 'test_admin', role: 'admin', displayName: 'Admin' },
    agent: { username: 'test_agent', role: 'agent', displayName: 'Agent1' },
    confirmation: { username: 'test_confirmation', role: 'confirmation', displayName: 'Confirmation1' },
    gallery: { username: 'test_gallery', role: 'gallery', displayName: 'Content Team' }
  };
  const auth = Object.fromEntries(Object.entries(users).map(([role, user]) => [role, jwt.sign(user)]));
  async function request(method, route, options = {}) {
    const req = Object.assign(new EventEmitter(), {
      headers: options.role === null ? {} : { authorization: `Bearer ${auth[options.role || 'agent']}` },
      params: options.params || {}, body: options.body || {}, query: options.query || {},
      file: options.file, rawBody: options.rawBody, get: () => 'api.example.invalid'
    });
    Object.assign(req.headers, options.headers || {});
    const res = {
      statusCode: 200, body: null, chunks: [], writableEnded: false, destroyed: false,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; this.writableEnded = true; return this; },
      send(body) { this.body = body; this.writableEnded = true; return this; },
      sendStatus(code) { this.statusCode = code; this.writableEnded = true; return this; },
      setHeader() {}, flushHeaders() {},
      write(chunk) { this.chunks.push(JSON.parse(chunk.slice(6))); },
      end() { this.writableEnded = true; }
    };
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `Route exists: ${method} ${route}`);
    async function run(index) {
      if (index >= handlers.length || res.writableEnded) return;
      let next;
      await handlers[index](req, res, () => { next = run(index + 1); });
      if (next) await next;
    }
    await run(0);
    await new Promise(setImmediate);
    return { req, res };
  }
  const order = { phone: '201000000000', name: 'Synthetic Customer', order: 'TEST_ORDER_001',
    items: 'TEST ITEM', address: 'TEST ADDRESS', contact: 'TEST CONTACT', total: '100' };
  function signedOrder() {
    return { ...order, sig: crypto.createHmac('sha256', env.ORDER_CONFIRMATION_LINK_SECRET)
      .update(api.getOrderConfirmationCanonicalPayload(order)).digest('hex') };
  }
  return { api, request, calls, states, users, tokens, env, order, signedOrder,
    setLookupError(value) { lookupError = value; }, setLookupHook(value) { lookupHook = value; },
    setFetchHook(value) { fetchHook = value; }, setSavedMediaItems(items) { savedMediaItems = items; } };
}

const protectedRoutes = [
  ['POST', '/api/send-message', { message: 'TEST TEXT' }],
  ['POST', '/api/send-message', { messageKind: 'reaction', messageId: 'TEST_ORIGINAL_MID', emoji: '❤️' }],
  ['POST', '/api/dashboard-action', { actionId: 'memory_foam' }],
  ['POST', '/api/send-template', { templateId: 'followup' }],
  ['POST', '/api/meta-purchase', { amount: 100 }],
  ['POST', '/api/ai-status', { ai_enabled: false }],
  ['GET', '/api/ai-status/:sessionId', {}],
  ['GET', '/api/messages/:sessionId', {}],
  ['GET', '/api/media/:sessionId', {}],
  ['POST', '/api/saved-media-items/:id/send', {}],
  ['POST', '/api/saved-media-items/send-batch', { itemIds: [1] }],
  ['POST', '/api/saved-media-folders/:id/send', {}],
  ...['image', 'video', 'audio', 'file'].map(messageKind => ['POST', '/api/send-media', { messageKind }])
];

for (const channel of ['whatsapp', 'messenger']) {
  for (const [label, state, role] of [
    ['user-hidden agent', { hiddenFor: ['test_agent'] }, 'agent'],
    ['globally-hidden agent', { hidden: true }, 'agent'],
    ['unconfirmed session', {}, 'confirmation'],
    ['user-hidden confirmation', { confirmation: true, hiddenFor: ['test_confirmation'] }, 'confirmation'],
    ['globally-hidden confirmation', { confirmation: true, hidden: true }, 'confirmation'],
    ['gallery role', { confirmation: true }, 'gallery']
  ]) {
    test(`${channel}: ${label} cannot read/send media, text, reactions, actions or change AI`, async () => {
      const f = await fixture();
      const sessionId = channel === 'messenger' ? 'fb:TEST_CUSTOMER' : '201000000000';
      f.states.set(sessionId, state);
      for (const [method, route, extra] of protectedRoutes) {
        f.calls.sql.length = 0;
        const { res } = await f.request(method, route, { role, params: { sessionId, id: '1' },
          body: { sessionId, ...extra }, file: { path: '/synthetic/test.bin', filename: 'test.bin', mimetype: 'application/octet-stream', size: 100 } });
        assert.equal(res.statusCode, 403, `${method} ${route}`);
        assert.equal(f.calls.sql.filter(c => !c.sql.includes('AS globally_hidden')).length, 0, 'no downstream DB work');
      }
      assert.equal(f.calls.fetch.length, 0, 'no outbound HTTP');
      assert.equal(f.calls.ffmpeg, 0, 'no media conversion');
      assert.equal(f.api.sendMediaJobs.size, 0, 'no background jobs');
    });
  }

  for (const role of ['admin', 'agent', 'confirmation']) {
    test(`${channel}: authorized ${role} keeps original text/reaction/action/template and AI paths`, async () => {
      const f = await fixture();
      const sessionId = channel === 'messenger' ? 'fb:TEST_CUSTOMER' : '201000000000';
      f.states.set(sessionId, { confirmation: true, hidden: role === 'admin', hiddenFor: role === 'admin' ? ['test_admin'] : [] });
      for (const [method, route, extra] of protectedRoutes.slice(0, 9)) {
        const { res } = await f.request(method, route, { role, params: { sessionId }, body: { sessionId, ...extra } });
        assert.equal(res.statusCode, 200, `${method} ${route}`);
      }
      const text = f.calls.fetch.find(c => JSON.parse(c.options.body).message === 'TEST TEXT');
      assert.equal(text.url, f.env[channel === 'messenger' ? 'N8N_FB_SEND_WEBHOOK_URL' : 'N8N_SEND_WEBHOOK_URL']);
      assert.equal(JSON.parse(text.options.body).sessionId, sessionId);
      assert.equal(JSON.parse(text.options.body).agentName, f.users[role].displayName);
    });
  }
}

test('SSE filters messages, reactions, refresh, labels and AI events by live visibility', async () => {
  const f = await fixture();
  const streams = {};
  for (const role of ['admin', 'agent', 'confirmation']) streams[role] = (await f.request('GET', '/api/events', { role })).res;
  assert.equal((await f.request('GET', '/api/events', { role: 'gallery' })).res.statusCode, 403);
  assert.equal((await f.request('GET', '/api/events', { role: null })).res.statusCode, 401);
  const sessionId = 'fb:TEST_CUSTOMER';
  const count = role => streams[role].chunks.filter(c => c.sessionId === sessionId).length;
  for (const type of ['new_message', 'reaction', 'refresh_messages', 'label_changed', 'ai_status_changed']) {
    await f.api.broadcastDashboardEvent({ type, sessionId, content: 'SYNTHETIC CONTENT' });
  }
  assert.equal(count('admin'), 5);
  assert.equal(count('agent'), 5);
  assert.equal(count('confirmation'), 0);
  f.states.set(sessionId, { confirmation: true, hiddenFor: ['test_agent'] });
  await f.api.broadcastDashboardEvent({ type: 'new_message', sessionId });
  assert.equal(count('admin'), 6);
  assert.equal(count('agent'), 5);
  assert.equal(count('confirmation'), 1);
  f.states.set(sessionId, { confirmation: true, hidden: true });
  await f.api.broadcastDashboardEvent({ type: 'new_message', sessionId });
  assert.equal(count('admin'), 7);
  assert.equal(count('confirmation'), 1);
  await f.api.broadcastDashboardEvent({ type: 'new_message', content: 'MISSING SESSION MUST NOT LEAK' });
  await f.api.broadcastDashboardEvent({ type: 'conversations_changed', content: 'MUST BE STRIPPED' });
  assert.equal(count('admin'), 7);
  assert.equal(streams.admin.chunks.at(-1).type, 'conversations_changed');
  assert.equal(streams.admin.chunks.at(-1).content, undefined);
});

test('SSE lookup failures fail closed; concurrent events retain order; disconnected/expired streams stop', async () => {
  const f = await fixture();
  const { req, res } = await f.request('GET', '/api/events');
  f.setLookupError(true);
  await f.api.broadcastDashboardEvent({ type: 'new_message', sessionId: 'fb:TEST', content: 'BLOCKED' });
  assert.equal(res.chunks.length, 1);
  f.setLookupError(false);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let first = true;
  f.setLookupHook(async () => { if (first) { first = false; await barrier; } });
  const one = f.api.broadcastDashboardEvent({ type: 'new_message', sessionId: 'fb:TEST', content: '1' });
  const two = f.api.broadcastDashboardEvent({ type: 'new_message', sessionId: 'fb:TEST', content: '2' });
  release(); await Promise.all([one, two]);
  assert.equal(res.chunks.slice(1).map(c => c.content).join(','), '1,2');
  req.emit('close');
  await f.api.broadcastDashboardEvent({ type: 'new_message', sessionId: 'fb:TEST' });
  assert.equal(res.chunks.length, 3);
  const expired = await f.request('GET', '/api/events');
  [...f.api.clients][0].expiresAt = Date.now() - 1;
  await f.api.broadcastDashboardEvent({ type: 'new_message', sessionId: 'fb:TEST' });
  assert.equal(expired.res.writableEnded, true);
});

test('push-update keeps payload unchanged but sends only to allowed SSE recipients', async () => {
  const f = await fixture();
  const agent = (await f.request('GET', '/api/events', { role: 'agent' })).res;
  const confirmation = (await f.request('GET', '/api/events', { role: 'confirmation' })).res;
  const body = { type: 'new_message', messageType: 'agent', sessionId: 'fb:TEST', messageKind: 'video',
    mediaUrl: 'https://media.example.invalid/test.mp4', external_message_id: 'TEST_MID', storage_id: 10,
    timestamp: '2026-01-01T00:00:00Z', caption: 'TEST CAPTION', reply_to: { external_message_id: 'TEST_REPLY' } };
  const { res } = await f.request('POST', '/api/push-update', { body, headers: { 'x-dashboard-secret': f.env.DASHBOARD_SECRET } });
  await f.api.broadcastDashboardEvent({ type: 'conversations_changed' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(agent.chunks.find(c => c.external_message_id === 'TEST_MID'), body);
  assert.equal(confirmation.chunks.some(c => c.external_message_id === 'TEST_MID'), false);
});

test('signed order context permits only scoped reads and order-confirmation send, never arbitrary sending or AI', async () => {
  const f = await fixture();
  const body = f.signedOrder();
  const context = await f.request('POST', '/api/order-confirmation/context', { role: 'confirmation', body });
  assert.equal(context.res.statusCode, 200);
  const headers = { 'x-order-confirmation-access': context.res.body.accessToken };
  for (const route of ['/api/messages/:sessionId', '/api/media/:sessionId']) {
    assert.equal((await f.request('GET', route, { role: 'confirmation', headers, params: { sessionId: body.phone } })).res.statusCode, 200);
    assert.equal((await f.request('GET', route, { role: 'confirmation', headers, params: { sessionId: '201000000001' } })).res.statusCode, 403);
  }
  assert.equal((await f.request('POST', '/api/send-message', { role: 'confirmation', headers, body: { sessionId: body.phone, message: 'TEST' } })).res.statusCode, 403);
  assert.equal((await f.request('POST', '/api/ai-status', { role: 'confirmation', headers, body: { sessionId: body.phone, ai_enabled: false } })).res.statusCode, 403);
  assert.equal((await f.request('POST', '/api/send-order-confirmation', { role: 'confirmation', body })).res.statusCode, 403);
  assert.equal((await f.request('POST', '/api/send-order-confirmation', { role: 'confirmation', headers, body: { ...body, order: 'DIFFERENT_ORDER' } })).res.statusCode, 403);
  assert.equal((await f.request('POST', '/api/send-order-confirmation', { role: 'confirmation', headers, body })).res.statusCode, 200);
  const sent = JSON.parse(f.calls.fetch.at(-1).options.body);
  assert.equal(sent.templateName, 'order_confirmation');
  assert.equal(sent.templateParameters.length, 7);
  assert.equal(sent.templateParameters[0], sent.templateParameters[6]);
  f.states.set(body.phone, { hiddenFor: ['test_confirmation'] });
  assert.equal((await f.request('POST', '/api/order-confirmation/context', { role: 'confirmation', body })).res.statusCode, 403);
  assert.equal((await f.request('GET', '/api/messages/:sessionId', { role: 'confirmation', headers, params: { sessionId: body.phone } })).res.statusCode, 403);
  assert.equal((await f.request('POST', '/api/send-order-confirmation', { role: 'confirmation', headers, body })).res.statusCode, 403);
});

test('invalid signed links, expired grants and globally hidden sessions never gain access', async () => {
  const f = await fixture();
  const body = f.signedOrder();
  assert.equal((await f.request('POST', '/api/order-confirmation/context', { role: 'confirmation', body: { ...body, sig: 'invalid' } })).res.statusCode, 403);
  const context = await f.request('POST', '/api/order-confirmation/context', { role: 'confirmation', body });
  const token = context.res.body.accessToken;
  f.tokens.get(token).exp = 1;
  const headers = { 'x-order-confirmation-access': token };
  assert.equal((await f.request('GET', '/api/messages/:sessionId', { role: 'confirmation', headers, params: { sessionId: body.phone } })).res.statusCode, 403);
  f.states.set(body.phone, { hidden: true });
  assert.equal((await f.request('POST', '/api/order-confirmation/context', { role: 'confirmation', body })).res.statusCode, 403);
  assert.equal((await f.request('POST', '/api/order-confirmation/context', { role: 'admin', body: f.order })).res.statusCode, 200);
});

test('saved-media single/batch/folder jobs retain session routing and protect status/cancel', async () => {
  const f = await fixture();
  const sessionId = 'fb:TEST';
  for (const route of ['/api/saved-media-items/:id/send', '/api/saved-media-items/send-batch', '/api/saved-media-folders/:id/send']) {
    const created = await f.request('POST', route, { params: { id: '1' }, body: { sessionId, itemIds: [1], caption: 'TEST CAPTION' } });
    assert.equal(created.res.statusCode, 200);
    const jobId = created.res.body.jobId;
    assert.equal(f.api.sendMediaJobs.get(jobId).sessionId, sessionId);
    assert.equal((await f.request('GET', '/api/saved-media-send-jobs/:jobId', { params: { jobId } })).res.statusCode, 200);
    assert.equal((await f.request('GET', '/api/saved-media-send-jobs/:jobId', { role: 'confirmation', params: { jobId } })).res.statusCode, 403);
    assert.equal((await f.request('POST', '/api/saved-media-send-jobs/:jobId/cancel', { role: 'confirmation', params: { jobId } })).res.statusCode, 403);
    assert.equal((await f.request('POST', '/api/saved-media-send-jobs/:jobId/cancel', { params: { jobId } })).res.statusCode, 200);
  }
  for (const call of f.calls.fetch) {
    assert.equal(call.url, f.env.N8N_FB_SEND_WEBHOOK_URL);
    assert.equal(JSON.parse(call.options.body).sessionId, sessionId);
  }
});

test('authorization lookup outage prevents sends and AI writes with 503', async () => {
  const f = await fixture(); f.setLookupError(true);
  for (const route of ['/api/send-message', '/api/ai-status']) {
    const { res } = await f.request('POST', route, { body: { sessionId: 'fb:TEST', message: 'TEST', ai_enabled: false } });
    assert.equal(res.statusCode, 503);
  }
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.sql.filter(c => !c.sql.includes('AS globally_hidden')).length, 0);
});

for (const channel of ['whatsapp', 'messenger']) {
  test(`${channel}: authorized Attach image/video/audio/file retain channel, caption and media processing`, async () => {
    const f = await fixture();
    const sessionId = channel === 'messenger' ? 'fb:TEST_CUSTOMER' : '201000000000';
    f.states.set(sessionId, { confirmation: true });
    for (const role of ['admin', 'agent', 'confirmation']) {
      for (const messageKind of ['image', 'video', 'audio', 'file']) {
        const before = f.calls.fetch.length;
        const { res } = await f.request('POST', '/api/send-media', { role,
          body: { sessionId, messageKind, caption: 'TEST CAPTION', isVoiceRecording: 'true' },
          file: { path: '/synthetic/test.bin', filename: 'test.bin', mimetype: 'application/octet-stream', size: 100 } });
        assert.equal(res.statusCode, 200, `${role} ${messageKind}`);
        assert.equal(f.calls.fetch.length, before + 1);
        const sent = f.calls.fetch.at(-1);
        assert.equal(sent.url, f.env[channel === 'messenger' ? 'N8N_FB_SEND_WEBHOOK_URL' : 'N8N_SEND_WEBHOOK_URL']);
        const payload = JSON.parse(sent.options.body);
        assert.equal(payload.sessionId, sessionId);
        assert.equal(payload.messageKind, messageKind);
        assert.equal(payload.message, 'TEST CAPTION');
        assert.equal(payload.agentName, f.users[role].displayName);
        assert.equal(payload.attachmentId, undefined);
        if (messageKind === 'audio') assert.ok(payload.mediaUrl.endsWith(channel === 'messenger' ? '.mp3' : '.ogg'));
        if (channel === 'messenger') assert.equal(res.body.queued, true);
      }
    }
  });
}

test('saved-media job stops sending further items when its creator loses session access', async () => {
  const f = await fixture();
  const sessionId = 'fb:TEST';
  const item = { media_kind: 'image', media_url: 'https://media.example.invalid/test.png' };
  f.setFetchHook(async () => { f.states.set(sessionId, { hiddenFor: ['test_agent'] }); });
  const job = f.api.startSendMediaJob([item, item], sessionId, 'Agent1', '', f.users.agent);
  await new Promise(setImmediate);
  assert.equal(job.done, true);
  assert.equal(job.sent, 1);
  assert.equal(job.failed, 1);
  assert.equal(f.calls.fetch.length, 1);
});

test('Messenger incoming webhook signature and n8n forwarding remain unchanged', async () => {
  const f = await fixture();
  const body = { object: 'page', entry: [{ id: 'TEST_PAGE', messaging: [{
    sender: { id: 'TEST_CUSTOMER' }, recipient: { id: 'TEST_PAGE' },
    timestamp: 1767225600000, message: { mid: 'TEST_INCOMING_MID', text: 'SYNTHETIC' }
  }] }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', f.env.META_APP_SECRET).update(rawBody).digest('hex');
  assert.equal((await f.request('POST', '/api/webhooks/messenger', { role: null, body, rawBody,
    headers: { 'x-hub-signature-256': signature } })).res.statusCode, 200);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.fetch[0].url, f.env.N8N_MESSENGER_WEBHOOK_URL);
  const forwarded = JSON.parse(f.calls.fetch[0].options.body);
  assert.equal(forwarded.event.message.mid, 'TEST_INCOMING_MID');
  assert.equal((await f.request('POST', '/api/webhooks/messenger', { role: null, body, rawBody,
    headers: { 'x-hub-signature-256': 'sha256=INVALID' } })).res.statusCode, 401);
  assert.equal(f.calls.fetch.length, 1);
});

test('SSE keeps Admin delivery on lookup outage and queries once per event for multiple recipients', async () => {
  const f = await fixture();
  const admin = (await f.request('GET', '/api/events', { role: 'admin' })).res;
  const agent = (await f.request('GET', '/api/events', { role: 'agent' })).res;
  const confirmation = (await f.request('GET', '/api/events', { role: 'confirmation' })).res;
  f.setLookupError(true);
  await f.api.broadcastDashboardEvent({ type: 'new_message', sessionId: 'fb:TEST', content: 'TEST' });
  assert.equal(admin.chunks.length, 2);
  assert.equal(agent.chunks.length, 1);
  assert.equal(confirmation.chunks.length, 1);
  assert.equal(f.calls.sql.filter(c => c.sql.includes('AS globally_hidden')).length, 1);
});

test('signed context does not expand SSE; after template save the Confirmation session becomes visible', async () => {
  const f = await fixture();
  const stream = (await f.request('GET', '/api/events', { role: 'confirmation' })).res;
  const body = f.signedOrder();
  const context = await f.request('POST', '/api/order-confirmation/context', { role: 'confirmation', body });
  assert.equal(context.res.statusCode, 200);
  await f.api.broadcastDashboardEvent({ type: 'new_message', sessionId: body.phone, content: 'BEFORE TEMPLATE' });
  assert.equal(stream.chunks.length, 1);
  f.states.set(body.phone, { confirmation: true });
  await f.api.broadcastDashboardEvent({ type: 'new_message', sessionId: body.phone, messageKind: 'template' });
  assert.equal(stream.chunks.length, 2);
  f.states.set(body.phone, { confirmation: true, hiddenFor: ['test_confirmation'] });
  await f.api.broadcastDashboardEvent({ type: 'reaction', sessionId: body.phone, emoji: '❤️' });
  assert.equal(stream.chunks.length, 2);
});

test('missing sessions and frontend role overrides cannot authorize sending', async () => {
  const f = await fixture();
  assert.equal((await f.request('POST', '/api/send-message', { body: { message: 'TEST' } })).res.statusCode, 400);
  assert.equal((await f.request('POST', '/api/send-message', { role: 'confirmation', body: {
    sessionId: 'fb:TEST', message: 'TEST', role: 'admin', signedOrderContext: true
  } })).res.statusCode, 403);
  assert.equal(f.calls.fetch.length, 0);
});

test('SSE never leaks missing, malformed, conflicting or whitespace-hidden session identities', async () => {
  const f = await fixture();
  const stream = (await f.request('GET', '/api/events', { role: 'agent' })).res;
  f.states.set('fb:TEST_HIDDEN', { hiddenFor: ['test_agent'] });
  for (const identity of [
    {}, { session_id: 'fb:TEST_HIDDEN' }, { sessionId: ' fb:TEST_HIDDEN ' },
    { sessionId: ['fb:TEST_HIDDEN'] }, { session_id: { id: 'fb:TEST_HIDDEN' } },
    { sessionId: 'fb:TEST_VISIBLE', session_id: 'fb:TEST_HIDDEN' }
  ]) {
    await f.api.broadcastDashboardEvent({ type: 'new_message', ...identity, content: 'MUST NOT LEAK' });
  }
  assert.equal(stream.chunks.length, 1, 'only the connection handshake is delivered');
  await f.api.broadcastDashboardEvent({ type: 'new_message', session_id: 'fb:TEST_VISIBLE', content: 'ALLOWED' });
  assert.equal(stream.chunks.at(-1).content, 'ALLOWED');
});

test('session-free SSE metadata strips nested messages, IDs and media from every global event', async () => {
  const f = await fixture();
  const stream = (await f.request('GET', '/api/events', { role: 'confirmation' })).res;
  for (const type of ['conversations_changed', 'label_changed', 'saved_replies_changed', 'test_event', 'unread_changed']) {
    const payload = { type, all: true, sessionIds: ['fb:TEST_HIDDEN'], content: 'PRIVATE',
      mediaUrl: 'https://media.example.invalid/private.png', message: { sessionId: 'fb:TEST_HIDDEN', text: 'PRIVATE' } };
    await f.api.broadcastDashboardEvent(payload);
    const delivered = stream.chunks.at(-1);
    assert.equal(delivered.type, type);
    assert.deepEqual(Object.keys(delivered).sort(), type === 'unread_changed' ? ['all', 'sessionId', 'type'] : ['type']);
  }
  const before = stream.chunks.length;
  for (const type of ['reaction', 'new_message', 'refresh_messages', 'ai_status_changed', 'unknown']) {
    await f.api.broadcastDashboardEvent({ type, message: { sessionId: 'fb:TEST_HIDDEN', text: 'PRIVATE' } });
  }
  assert.equal(stream.chunks.length, before);
});

test('sending cannot bypass hidden-session authorization through surrounding whitespace', async () => {
  const f = await fixture();
  f.states.set('fb:TEST_HIDDEN', { hiddenFor: ['test_agent'] });
  const { res } = await f.request('POST', '/api/send-message', {
    body: { sessionId: 'fb:TEST_HIDDEN ', message: 'MUST NOT SEND' }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(f.calls.fetch.length, 0);
});

for (const channel of ['whatsapp', 'messenger']) {
  for (const role of ['admin', 'agent', 'confirmation']) {
    test(`${channel}: ${role} can send Saved Media kinds through single, batch and folder routes`, async () => {
      const f = await fixture();
      const sessionId = channel === 'messenger' ? 'fb:TEST_CUSTOMER' : '201000000000';
      f.states.set(sessionId, { confirmation: true, hidden: role === 'admin' });
      const items = ['image', 'video', 'audio', 'file'].map((media_kind, index) => ({
        id: index + 1, media_kind, media_url: `https://media.example.invalid/test-${index}.bin`,
        thumbnail_url: '', file_path: ''
      }));
      f.setSavedMediaItems(items);
      for (const item of items) {
        const result = await f.request('POST', '/api/saved-media-items/:id/send', {
          role, params: { id: String(item.id) }, body: { sessionId, caption: 'TEST CAPTION' }
        });
        assert.equal(result.res.statusCode, 200);
        const job = f.api.sendMediaJobs.get(result.res.body.jobId);
        assert.equal(job.sent, 1); assert.equal(job.failed, 0); assert.equal(job.done, true);
        assert.equal(JSON.parse(f.calls.fetch.at(-1).options.body).messageKind, item.media_kind);
      }
      for (const route of ['/api/saved-media-items/send-batch', '/api/saved-media-folders/:id/send']) {
        const result = await f.request('POST', route, { role, params: { id: '1' },
          body: { sessionId, itemIds: items.map(item => item.id) } });
        assert.equal(result.res.statusCode, 200);
        const job = f.api.sendMediaJobs.get(result.res.body.jobId);
        assert.equal(job.sent, 4); assert.equal(job.failed, 0); assert.equal(job.done, true);
      }
      assert.equal(f.calls.fetch.length, 12);
      for (const call of f.calls.fetch) {
        assert.equal(call.url, f.env[channel === 'messenger' ? 'N8N_FB_SEND_WEBHOOK_URL' : 'N8N_SEND_WEBHOOK_URL']);
        assert.equal(JSON.parse(call.options.body).sessionId, sessionId);
        assert.equal(JSON.parse(call.options.body).agentName, f.users[role].displayName);
      }
    });
  }
}
