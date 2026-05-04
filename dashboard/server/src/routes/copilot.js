// /api/copilot — Gemini-powered agent assist (FR-10, FR-11)
const router = require('express').Router();
const pool   = require('../db/pg');
const { authenticate } = require('../middleware/auth');
const { client: redisClient, keys, ensureConnected } = require('../lib/redis');
require('dotenv').config();

router.use(authenticate);

const GEMINI_MODEL = process.env.MODEL || 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
const TIMEOUT_MS = 8000;

async function callGemini(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } finally {
    clearTimeout(timer);
  }
}

// Rate-limit check (60 req/min per agent) — returns true (allow) if Redis is down
async function checkRateLimit(agentId) {
  try {
    await ensureConnected();
    const key = keys.geminiRate(agentId);
    const count = await redisClient.incr(key);
    if (count === 1) await redisClient.expire(key, 60);
    return count <= 60;
  } catch {
    return true; // Redis unavailable — allow the request
  }
}

async function getLastMessages(ticketId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT sender_type, content FROM messages
     WHERE ticket_id=$1 AND sender_type != 'internal_note'
     ORDER BY created_at DESC LIMIT $2`,
    [ticketId, limit]
  );
  return rows.reverse();
}

// ── POST /api/copilot/summarize (FR-10) ──────────────────────────────────────
// Returns 3-bullet summary; caller saves as internal_note
router.post('/summarize', async (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId required' });

  const allowed = await checkRateLimit(req.user.id);
  if (!allowed) return res.status(429).json({ error: 'Rate limit reached. Try again in a minute.' });

  try {
    const msgs = await getLastMessages(ticketId, 20);
    if (msgs.length < 3) return res.status(400).json({ error: 'Need at least 3 messages to summarize' });

    const thread = msgs.map(m => `[${m.sender_type}]: ${m.content}`).join('\n');
    const prompt = `Summarize this support thread in exactly 3 lines, no markdown, no asterisks, no bullet symbols. Use this exact format:\nIssue: <one sentence>\nActions: <one sentence>\nStatus: <one sentence>\n\n${thread}`;

    const summary = await callGemini(prompt);

    // Save as internal_note
    await pool.query(
      `INSERT INTO messages (ticket_id, sender_type, sender_id, content, metadata)
       VALUES ($1,'internal_note',$2,$3,'{"source":"gemini_summary"}')`,
      [ticketId, req.user.id, summary.trim()]
    );

    res.json({ summary: summary.trim() });
  } catch (err) {
    console.error('[copilot] summarize error:', err.message);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'AI Assist unavailable.' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/copilot/draft (FR-11) ──────────────────────────────────────────
// Expands shorthand — NEVER auto-sends, always returns to composer
router.post('/draft', async (req, res) => {
  const { ticketId, shorthand } = req.body;
  if (!ticketId || !shorthand?.trim()) return res.status(400).json({ error: 'ticketId and shorthand required' });

  const allowed = await checkRateLimit(req.user.id);
  if (!allowed) return res.status(429).json({ error: 'Rate limit reached. Try again in a minute.' });

  try {
    const msgs = await getLastMessages(ticketId, 10);
    const context = msgs.map(m => `[${m.sender_type}]: ${m.content}`).join('\n');
    const prompt = `You are a Bitazza customer support agent. Expand the following shorthand into a professional, helpful, clear, formal and empathetic reply. Do not introduce new information. Do not send — return draft only.\n\nConversation context:\n${context}\n\nAgent shorthand: ${shorthand}`;

    const draft = await callGemini(prompt);
    res.json({ draft: draft.trim() });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'AI Assist unavailable.' });
    console.error('[copilot] draft error:', err.message);
    res.status(500).json({ error: 'AI Assist unavailable.' });
  }
});

// ── POST /api/copilot/suggest-reply ──────────────────────────────────────────
router.post('/suggest-reply', async (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId required' });

  const allowed = await checkRateLimit(req.user.id);
  if (!allowed) return res.status(429).json({ error: 'Rate limit reached.' });

  try {
    const msgs = await getLastMessages(ticketId, 10);
    const thread = msgs.map(m => `[${m.sender_type}]: ${m.content}`).join('\n');
    const prompt = `You are a Bitazza support agent. Suggest a professional, empathetic reply to the customer based on this thread. Return only the reply text, no explanation.\n\n${thread}`;
    const suggestion = await callGemini(prompt);
    res.json({ suggestion: suggestion.trim() });
  } catch (err) {
    console.error('[copilot] suggest-reply error:', err.message);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'AI Assist unavailable.' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/copilot/sentiment ───────────────────────────────────────────────
router.post('/sentiment', async (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId required' });
  try {
    const msgs = await getLastMessages(ticketId, 5);
    const thread = msgs.map(m => `[${m.sender_type}]: ${m.content}`).join('\n');
    const prompt = `Analyze the customer sentiment in this support conversation. Reply with exactly one word: positive, neutral, or negative.\n\n${thread}`;
    const raw = await callGemini(prompt);
    const sentiment = raw.trim().toLowerCase().includes('positive') ? 'positive'
                    : raw.trim().toLowerCase().includes('negative') ? 'negative'
                    : 'neutral';
    res.json({ sentiment });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'AI Assist unavailable.' });
    res.status(500).json({ error: 'AI Assist unavailable.' });
  }
});

// ── POST /api/copilot/draft-assisted ─────────────────────────────────────────
// Generates a reply guided by agent instruction + optional partial draft
router.post('/draft-assisted', async (req, res) => {
  const { ticketId, instruction = '', partialDraft = '' } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId required' });

  const allowed = await checkRateLimit(req.user.id);
  if (!allowed) return res.status(429).json({ error: 'Rate limit reached.' });

  try {
    const msgs = await getLastMessages(ticketId, 10);
    const thread = msgs.map(m => `[${m.sender_type}]: ${m.content}`).join('\n');

    const parts = [
      'You are a Bitazza customer support agent helping a human agent compose a reply.',
      'Match the language (Thai or English) used by the customer.',
      'Return ONLY the draft reply text — no explanation, no preamble.',
      '',
      `CONVERSATION:\n${thread}`,
    ];
    if (partialDraft.trim()) parts.push(`\nAGENT'S PARTIAL DRAFT (improve/complete this):\n${partialDraft.trim()}`);
    if (instruction.trim()) parts.push(`\nAGENT'S INSTRUCTION: ${instruction.trim()}`);
    parts.push('\nDRAFT REPLY:');

    const draft = await callGemini(parts.join('\n'));

    // Log to ai_drafts table (best-effort)
    pool.query(
      `INSERT INTO ai_drafts (ticket_id, agent_id, instruction, partial_draft, generated)
       VALUES ($1, $2, $3, $4, $5)`,
      [ticketId, req.user.id, instruction, partialDraft, draft.trim()]
    ).catch(err => console.warn('[copilot] draft-assisted log failed:', err.message));

    res.json({ draft: draft.trim() });
  } catch (err) {
    console.error('[copilot] draft-assisted error:', err.message);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'AI Assist unavailable.' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/copilot/related-tickets ────────────────────────────────────────
router.post('/related-tickets', async (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId required' });
  try {
    // Simple: same category, recently resolved
    const { rows: ticket } = await pool.query('SELECT category FROM tickets WHERE id=$1', [ticketId]);
    if (!ticket.length) return res.json({ related: [] });

    const { rows } = await pool.query(`
      SELECT t.id, c.name AS customer_name, t.category, t.status, t.created_at,
             (SELECT content FROM messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_message
      FROM tickets t
      LEFT JOIN customers c ON t.customer_id = c.id
      WHERE t.category = $1
        AND t.status IN ('Closed_Resolved','Closed_Unresponsive')
        AND t.id != $2
      ORDER BY t.updated_at DESC
      LIMIT 3
    `, [ticket[0].category, ticketId]);
    res.json({ related: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
