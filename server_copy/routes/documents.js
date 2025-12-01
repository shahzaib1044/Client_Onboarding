// routes/documents.js
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const { supabaseAdmin } = require('../utils/supabase');
const { requireAuth, requireRole, auditLog } = require('../utils/middleware');

const router = express.Router();
const BUCKET = process.env.SUPABASE_DOCUMENTS_BUCKET || 'documents';
const SIGNED_URL_EXPIRES_SEC = 60 * 60; // 1 hour

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

/* ---------- Helper: build signed URL for a stored object ---------- */
async function buildSignedUrl(path) {
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_EXPIRES_SEC);
    if (error) {
      console.warn('Supabase createSignedUrl error', error);
      return null;
    }
    // supabase client returns data.signedURL or similar - handle variants
    return data?.signedURL || data?.signedUrl || data?.signed_url || null;
  } catch (err) {
    console.error('buildSignedUrl err', err);
    return null;
  }
}

/* ---------- POST /customers/:id/documents (upload) ---------- */
router.post('/customers/:id/documents', requireAuth, upload.array('files'), async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ message: 'No files uploaded' });

    // TODO: add fetch customer & authorization checks (keep existing logic)
    const results = [];
    for (const file of files) {
      const safeName = sanitize(file.originalname);

      const scanResult = await scanBufferForViruses(file.buffer);
      if (!scanResult.ok) {
        await auditLog(req, 'UPLOAD_DOCUMENT', 'DOCUMENT', customerId, 'FAILURE', `Virus detected in ${safeName}`);
        return res.status(400).json({ message: 'File failed virus scan' });
      }

      const key = `customer_${customerId}/${Date.now()}_${safeName}`;
      const { error: uploadErr } = await supabaseAdmin.storage.from(BUCKET).upload(key, file.buffer, { contentType: file.mimetype });

      if (uploadErr) throw uploadErr;

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
    // Build signed URLs before returning (optional but useful for frontend preview)
    const resultsWithUrls = await Promise.all(results.map(async (r) => {
      const signedUrl = await buildSignedUrl(r.file_path);
      return { ...r, file_url: signedUrl };
    }));

    res.status(201).json(resultsWithUrls);
  } catch (err) {
    console.error('upload error', err);
    await auditLog(req, 'UPLOAD_DOCUMENTS', 'DOCUMENT', parseInt(req.params.id, 10), 'FAILURE', err.message);
    res.status(500).json({ message: 'Failed to upload documents' });
  }
});

/* ---------- GET list documents for a customer ---------- */
router.get('/customers/:id/documents', requireAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    if (isNaN(customerId)) return res.status(400).json({ message: 'Invalid customer id' });

    // Optional: authorization checks

    const { data: rows, error: selectErr } = await supabaseAdmin
      .from('documents')
      .select('id, customer_id, file_name, file_path, file_size, mime_type, uploaded_at')
      .eq('customer_id', customerId)
      .order('uploaded_at', { ascending: false });

    if (selectErr) {
      console.error('select documents error', selectErr);
      return res.status(500).json({ message: 'Failed to fetch documents' });
    }

    const docsWithUrls = await Promise.all(rows.map(async (r) => {
      const signedUrl = await buildSignedUrl(r.file_path);
      return {
        id: r.id,
        customer_id: r.customer_id,
        file_name: r.file_name,
        file_path: r.file_path,
        file_size: r.file_size,
        mime_type: r.mime_type,
        uploaded_at: r.uploaded_at,
        file_url: signedUrl
      };
    }));

    return res.json(docsWithUrls);
  } catch (err) {
    console.error('GET documents error', err);
    await auditLog(req, 'LIST_DOCUMENTS', 'DOCUMENT', parseInt(req.params.id, 10), 'FAILURE', err.message);
    return res.status(500).json({ message: 'Failed to list documents' });
  }
});

/* ---------- GET download proxy (redirect to signed URL) ---------- */
router.get('/customers/:id/documents/:docId/download', requireAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    const docId = req.params.docId;

    const { data: docRow, error } = await supabaseAdmin.from('documents').select('*').eq('id', docId).single();
    if (error || !docRow) return res.status(404).json({ message: 'Document not found' });
    if (docRow.customer_id !== customerId) return res.status(403).json({ message: 'Forbidden' });

    const signedUrl = await buildSignedUrl(docRow.file_path);
    if (!signedUrl) return res.status(500).json({ message: 'Failed to generate file URL' });

    return res.redirect(signedUrl);
  } catch (err) {
    console.error('download proxy error', err);
    return res.status(500).json({ message: 'Failed to download document' });
  }
});

/* ---------- DELETE document (remove storage object + DB row) ---------- */
router.delete('/customers/:id/documents/:docId', requireAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    const docId = req.params.docId;

    const { data: docRow, error: fetchErr } = await supabaseAdmin.from('documents').select('*').eq('id', docId).single();
    if (fetchErr || !docRow) return res.status(404).json({ message: 'Document not found' });
    if (docRow.customer_id !== customerId) return res.status(403).json({ message: 'Forbidden' });

    const { error: removeErr } = await supabaseAdmin.storage.from(BUCKET).remove([docRow.file_path]);
    if (removeErr) {
      console.warn('Supabase remove error', removeErr);
      // proceed to delete DB row anyway (or change behavior if you prefer rollback)
    }

    const { error: delErr } = await supabaseAdmin.from('documents').delete().eq('id', docId);
    if (delErr) {
      console.error('delete row error', delErr);
      return res.status(500).json({ message: 'Failed to delete document' });
    }

    await auditLog(req, 'DELETE_DOCUMENT', 'DOCUMENT', customerId, 'SUCCESS', `Deleted document ${docId}`);
    return res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('DELETE document error', err);
    await auditLog(req, 'DELETE_DOCUMENT', 'DOCUMENT', parseInt(req.params.id, 10), 'FAILURE', err.message);
    return res.status(500).json({ message: 'Failed to delete document' });
  }
});

module.exports = router;
