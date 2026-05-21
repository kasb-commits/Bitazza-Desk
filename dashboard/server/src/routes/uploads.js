const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'attachments');

// ── Multer setup ──────────────────────────────────────────────────────────────

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]/g, '_').slice(0, 120);
    cb(null, `${uuidv4()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`File type '${file.mimetype}' is not allowed.`));
  },
});

// ── POST /api/uploads/attachment ──────────────────────────────────────────────

router.post('/attachment', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const fileId   = req.file.filename.split('_')[0]; // uuid portion
  const safeName = req.file.filename.slice(fileId.length + 1);
  const url      = `${req.protocol}://${req.get('host')}/uploads/attachments/${req.file.filename}`;

  return res.json({
    id:        fileId,
    url,
    name:      safeName,
    mime_type: req.file.mimetype,
    size:      req.file.size,
  });
});

// multer error handler (file type / size rejections)
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds the 10 MB size limit.' });
  }
  return res.status(415).json({ error: err.message || 'Upload error.' });
});

module.exports = router;
