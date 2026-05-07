// /api/knowledge — Knowledge Base CRUD
// LIST and DELETE are served directly from Postgres.
// ADD (url/upload) and CHUNKS proxy to the Python AI engine which owns ChromaDB.
const router  = require('express').Router();
const pool    = require('../db/pg');
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

// ── Helper: convert DB row → API shape (created_at as unix seconds) ───────────
function toItem(row) {
  return {
    id:          row.id,
    title:       row.title,
    source_type: row.source_type,
    source_ref:  row.source_ref,
    chunk_count: row.chunk_count,
    created_by:  row.created_by,
    created_at:  row.created_at ? Math.floor(new Date(row.created_at).getTime() / 1000) : null,
  };
}

// ── GET /api/knowledge — list all items ──────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM knowledge_items ORDER BY created_at DESC'
    );
    res.json({ items: rows.map(toItem) });
  } catch (err) {
    console.error('[knowledge] list error:', err.message);
    res.status(500).json({ error: 'Failed to load knowledge items' });
  }
});

// ── POST /api/knowledge/url — scrape a URL (proxied to Python engine) ─────────
router.post('/url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/url`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': req.headers['authorization'] ?? '',
      },
      body: JSON.stringify({ url }),
    });
    const data = await pyJson(pyRes);
    res.json(toItem(data));
  } catch (err) {
    console.error('[knowledge] add url error:', err.message);
    const status = err.status && err.status < 500 ? err.status : 422;
    res.status(status).json({ error: err.message });
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
      headers: {
        'Authorization': req.headers['authorization'] ?? '',
      },
      body: form,
    });
    const data = await pyJson(pyRes);
    res.json(toItem(data));
  } catch (err) {
    console.error('[knowledge] upload error:', err.message);
    const status = err.status && err.status < 500 ? err.status : 422;
    res.status(status).json({ error: err.message });
  }
});

// ── GET /api/knowledge/:id/chunks — preview indexed chunks (proxied) ──────────
router.get('/:id/chunks', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    // Do not forward the dashboard JWT — Python uses its own auth (dev fallback: dev_user)
    const pyRes = await fetch(`${PYTHON_API}/api/knowledge/${id}/chunks`);
    const data = await pyRes.json();
    if (!pyRes.ok) {
      console.error('[knowledge] chunks python error:', pyRes.status, data);
      return res.json({ item_id: id, chunks: [] });
    }
    res.json(data);
  } catch (err) {
    console.error('[knowledge] chunks error:', err.message);
    res.json({ item_id: id, chunks: [] });
  }
});

// ── DELETE /api/knowledge/:id ─────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  // Best-effort: delete vector chunks from Python engine first
  try {
    await fetch(`${PYTHON_API}/api/knowledge/${id}`, { method: 'DELETE' });
  } catch {
    // Python engine may be offline — still delete the DB row
  }

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM knowledge_items WHERE id = $1', [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[knowledge] delete error:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
