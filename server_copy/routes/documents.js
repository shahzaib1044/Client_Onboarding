// routes/documents.js  (only the top part / upload route shown; merge into your file)
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename'); // prevents directory traversal in file names
const { supabaseAdmin } = require('../utils/supabase');
const { requireAuth, requireRole, auditLog } = require('../utils/middleware');

const router = express.Router();
const BUCKET = process.env.SUPABASE_DOCUMENTS_BUCKET || 'documents';

// memory storage (we scan buffer before saving to storage)
const storage = multer.memoryStorage();

// Allowed MIME types
const ALLOWED_MIMES = ['application/pdf', 'image/png', 'image/jpeg'];

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      return cb(new Error('Invalid file type'), false);
    }
    cb(null, true);
  }
});

// Placeholder virus/AV scan function - integrate ClamAV or a scanning service here
async function scanBufferForViruses(buffer) {
  // TODO: replace with real scanning logic (ClamAV, external API)
  // Return { ok: true } when clean or { ok: false, reason: '...' } when infected
  return { ok: true };
}

router.post('/customers/:id/documents', requireAuth, upload.array('files'), async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ message: 'No files uploaded' });

    // fetch customer & authorization checks (omitted here for brevity - keep your existing logic)

    const results = [];
    for (const file of files) {
      // sanitize filename to avoid traversal or odd chars
      const safeName = sanitize(file.originalname);

      // scan before uploading
      const scanResult = await scanBufferForViruses(file.buffer);
      if (!scanResult.ok) {
        // log and reject
        await auditLog(req, 'UPLOAD_DOCUMENT', 'DOCUMENT', customerId, 'FAILURE', `Virus detected in ${safeName}`);
        return res.status(400).json({ message: 'File failed virus scan' });
      }

      // upload to Supabase storage (key includes sanitized name)
      const key = `customer_${customerId}/${Date.now()}_${safeName}`;
      const { error: uploadErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, file.buffer, { contentType: file.mimetype });

      if (uploadErr) throw uploadErr;

      // insert metadata
      const { data: docRow, error: insertErr } = await supabaseAdmin.from('documents').insert({
        customer_id: customerId,
        file_name: safeName,
        file_path: key,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_at: new Date().toISOString()
      }).select().single();

      if (insertErr) throw insertErr;
      results.push(docRow);
    }

    await auditLog(req, 'UPLOAD_DOCUMENTS', 'DOCUMENT', customerId, 'SUCCESS', `Uploaded ${results.length} files`);
    res.status(201).json(results);
  } catch (err) {
    console.error('upload error', err);
    await auditLog(req, 'UPLOAD_DOCUMENTS', 'DOCUMENT', parseInt(req.params.id, 10), 'FAILURE', err.message);
    res.status(500).json({ message: 'Failed to upload documents' });
  }
});

module.exports = router;
