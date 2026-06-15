#!/usr/bin/env node
/**
 * CSBot SDK mock server.
 * Implements all endpoints the SDK calls with realistic fixture data.
 * Run: node server.js [--port 8001]
 *
 * WebSocket: ws://localhost:PORT/ws/:conversationId
 *   - Accepts {"type":"auth","token":...} handshake
 *   - Responds to {"type":"ping"} with {"type":"pong"}
 *   - Use the /push endpoint to broadcast a simulated agent message
 *
 * REST admin:
 *   POST /push { conversationId, content, agentName }  → broadcast agent message over WS
 *   GET  /health
 */
'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? '8001', 10);

// ── Fixture data ─────────────────────────────────────────────────────────────

const CONV_ID = 'mock-conv-001';
const TICKET_ID = 'mock-tkt-001';

let messageHistory = [
  { role: 'assistant', content: '👋 Hi! How can I help you today?', created_at: Math.floor(Date.now() / 1000) - 60 },
];

const BOT = { name: 'Aria', avatar: 'A', avatar_url: null };

// ── WS rooms ─────────────────────────────────────────────────────────────────

const rooms = new Map(); // conversationId → Set<WebSocket>

function roomBroadcast(convId, payload) {
  const room = rooms.get(convId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ── HTTP request handler ──────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const body = req.method === 'POST' ? await readBody(req) : {};

  // ── Chat routes ─────────────────────────────────────────────────────────────

  if (req.method === 'POST' && path === '/chat/start') {
    messageHistory = [{ role: 'assistant', content: '👋 Hi! How can I help you today?', created_at: Math.floor(Date.now() / 1000) }];
    send(res, 200, { conversation_id: CONV_ID, ticket_id: TICKET_ID, is_guest: false, customer_id: 'mock-cust-001' });
    return;
  }

  if (req.method === 'POST' && path === '/chat/greet') {
    send(res, 200, { greeting: '👋 Hi! How can I help you today?', bot_name: BOT.name, agent_avatar_url: BOT.avatar_url });
    return;
  }

  if (req.method === 'POST' && path === '/chat/set-category') {
    send(res, 200, { agent_name: BOT.name, agent_avatar: BOT.avatar, agent_avatar_url: BOT.avatar_url });
    return;
  }

  if (req.method === 'POST' && path === '/chat/message') {
    const userMsg = { role: 'user', content: body.message ?? '', created_at: Math.floor(Date.now() / 1000) };
    messageHistory.push(userMsg);

    // Simulate a bot reply
    const botReply = `[MOCK] You said: "${body.message}". Here's how I can help...`;
    const botMsg = { role: 'assistant', content: botReply, created_at: Math.floor(Date.now() / 1000) };
    messageHistory.push(botMsg);

    // Also push over WS so widget updates instantly
    roomBroadcast(body.conversation_id ?? CONV_ID, {
      type: 'new_message',
      message: { id: `msg-${Date.now()}`, role: 'assistant', content: botReply, timestamp: Date.now(), agentName: BOT.name },
    });

    send(res, 200, {
      reply: botReply,
      language: body.message?.match(/[฀-๿]/) ? 'th' : 'en',
      escalated: false,
      ticket_id: TICKET_ID,
      agent_name: BOT.name,
      agent_avatar: BOT.avatar,
      agent_avatar_url: BOT.avatar_url,
      offer_resolution: false,
      quick_replies: [],
      upgraded_category: null,
      transition_message: null,
    });
    return;
  }

  const historyMatch = path.match(/^\/chat\/history\/(.+)$/);
  if (req.method === 'GET' && historyMatch) {
    send(res, 200, { history: messageHistory, human_handling: false, ticket_status: 'Open_Live' });
    return;
  }

  if (req.method === 'GET' && path === '/chat/customer-tickets') {
    send(res, 200, { tickets: [], total: 0 });
    return;
  }

  if (req.method === 'GET' && path === '/chat/open-ticket') {
    send(res, 200, { ticket: null });
    return;
  }

  if (req.method === 'POST' && path === '/chat/csat') {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && path === '/chat/announcement') {
    send(res, 200, { announcements: [] });
    return;
  }

  if (req.method === 'POST' && path === '/chat/emergency-escalate') {
    send(res, 200, { conversation_id: CONV_ID, ticket_id: TICKET_ID });
    return;
  }

  if (req.method === 'POST' && path === '/api/logs/client') {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && path === '/api/uploads/attachment') {
    send(res, 200, { id: `att-${Date.now()}`, url: '/mock/attachment.png', name: 'attachment.png', mime_type: 'image/png', size: 1024 });
    return;
  }

  // ── Admin push (simulate incoming agent message) ─────────────────────────────

  if (req.method === 'POST' && path === '/push') {
    const convId = body.conversationId ?? CONV_ID;
    const agentMsg = {
      type: 'new_message',
      message: {
        id: `agent-${Date.now()}`,
        role: 'agent',
        content: body.content ?? 'Hello from a human agent!',
        timestamp: Date.now(),
        agentName: body.agentName ?? 'Support Agent',
        agentAvatar: 'S',
        agentAvatarUrl: null,
      },
    };
    roomBroadcast(convId, agentMsg);
    const pushed = { role: 'agent', content: agentMsg.message.content, created_at: Math.floor(Date.now() / 1000) };
    messageHistory.push(pushed);
    send(res, 200, { pushed: true, recipients: rooms.get(convId)?.size ?? 0 });
    return;
  }

  if (path === '/health') {
    send(res, 200, { status: 'ok', rooms: rooms.size });
    return;
  }

  send(res, 404, { error: 'not_found', path });
});

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: undefined });

wss.on('connection', (ws, req) => {
  const convId = req.url?.match(/\/ws\/(.+)/)?.[1];
  if (!convId) { ws.close(4008, 'no conversation id'); return; }

  let authed = false;
  const AUTH_TIMEOUT = setTimeout(() => {
    if (!authed) ws.close(4008, 'auth timeout');
  }, 5000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!authed) {
      if (msg.type !== 'auth') { ws.close(4008, 'expected auth frame'); return; }
      // In mock mode, accept any token (or null for guests)
      authed = true;
      clearTimeout(AUTH_TIMEOUT);
      if (!rooms.has(convId)) rooms.set(convId, new Set());
      rooms.get(convId).add(ws);
      ws.send(JSON.stringify({ type: 'connected', convId }));
      console.log(`[WS] client connected to conv ${convId}`);
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    rooms.get(convId)?.delete(ws);
    if (rooms.get(convId)?.size === 0) rooms.delete(convId);
    console.log(`[WS] client disconnected from conv ${convId}`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🟢 CSBot mock server running on http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws/<conversationId>`);
  console.log(`   Push agent message: POST http://localhost:${PORT}/push`);
  console.log(`     body: { "conversationId": "mock-conv-001", "content": "Hi!", "agentName": "Sara" }`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
