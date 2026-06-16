// /api/knowledge — Knowledge Base CRUD
// LIST and DELETE proxy to the Python AI engine so versioning + citations are handled there.
// Direct Postgres routes removed to avoid duplicating schema logic.
const router  = require('express').Router();
const multer  = require('multer');
const { authenticate, requirePermission } = require('../middleware/auth');

const PYTHON_API = process.env.PYTHON_API_URL || 'http://localhost:8000';

// All routes require authentication + section.knowledge
router.use(authenticate, requirePermission('section.knowledge'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Helper: safely parse Python response, surface detail errors ──────────────
async function pyJson(pyRes) {
  const text = await pyRes.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { detail: text }; }
  if (!pyRes.ok) {
    const msg = data?.detail ?? data?.error ?? `Python API error ${pyRes.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = pyRes.status;
    throw err;
  }
  return data;
}

// ── Helper: forward auth header ───────────────────────────────────────────────
function authHeader(req) {
  return req.headers['authorization'] ? { 'Authorization': req.headers['authorization'] } : {};
}

// ── GET /api/knowledge — list ACTIVE items (proxied to Python) ────────────────
router.get('/', async (req, res) => {
  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge`, {
      headers: authHeader(req),
    });
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] list error:', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── POST /api/knowledge/admin/classify-all — backfill citations ───────────────
// MUST be before /:id routes to prevent 'admin' being parsed as :id
router.post('/admin/classify-all', async (req, res) => {
  console.log('[knowledge] classify-all hit, proxying to', `${PYTHON_API}/api/knowledge/admin/classify-all`);
  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/admin/classify-all`, {
      method:  'POST',
      headers: authHeader(req),
    });
    console.log('[knowledge] classify-all python status:', pyRes.status);
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] classify-all error:', err.status, err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── POST /api/knowledge/admin/bulk-ingest-blog ────────────────────────────────
router.post('/admin/bulk-ingest-blog', async (req, res) => {
  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/admin/bulk-ingest-blog`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(req) },
      body:    JSON.stringify(req.body),
    });
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] bulk-ingest-blog error:', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── POST /api/knowledge/url — scrape a URL (proxied to Python engine) ─────────
router.post('/url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/url`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(req) },
      body:    JSON.stringify({ url }),
    });
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] add url error:', err.message);
    res.status(err.status ?? 422).json({ error: err.message });
  }
});

// ── POST /api/knowledge/upload — upload PDF/DOCX (proxied to Python engine) ──
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  try {
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);

    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/upload`, {
      method:  'POST',
      headers: authHeader(req),
      body:    form,
    });
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] upload error:', err.message);
    res.status(err.status ?? 422).json({ error: err.message });
  }
});

// ── GET /api/knowledge/:id/chunks — preview indexed chunks (proxied) ──────────
router.get('/:id/chunks', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/${id}/chunks`, {
      headers: authHeader(req),
    });
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] chunks error:', err.message);
    res.json({ item_id: id, chunks: [] });
  }
});

// ── GET /api/knowledge/:id/versions — version history (proxied) ──────────────
router.get('/:id/versions', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/${id}/versions`, {
      headers: authHeader(req),
    });
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] versions error:', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── PATCH /api/knowledge/:id/citations — update citations (proxied) ───────────
router.patch('/:id/citations', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/${id}/citations`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(req) },
      body:    JSON.stringify(req.body),
    });
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] patch citations error:', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── POST /api/knowledge/:id/override — override with new version (proxied) ────
router.post('/:id/override', upload.single('file'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const form = new FormData();
    if (req.file) {
      form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    }
    if (req.body.url)          form.append('url', req.body.url);
    if (req.body.change_notes) form.append('change_notes', req.body.change_notes);

    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/${id}/override`, {
      method:  'POST',
      headers: authHeader(req),
      body:    form,
    });
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] override error:', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// ── DELETE /api/knowledge/:id — delete item + version chain (proxied) ─────────
// Proxied to Python so delete_knowledge_item_chain cascades all versions + chunks.
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/${id}`, {
      method:  'DELETE',
      headers: authHeader(req),
    });
    if (pyRes.status === 204) return res.status(204).send();
    const data = await pyJson(pyRes);
    res.json(data);
  } catch (err) {
    console.error('[knowledge] delete error:', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

module.exports = router;
