// routes/audit.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../utils/supabase');
const { requireAuth, requireRole } = require('../utils/middleware');

// GET /api/audit-logs?page=&limit=&user_id=&from=
router.get('/', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '50');
    const offset = (page - 1) * limit;

    let query = supabaseAdmin.from('audit_logs').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    if (req.query.user_id) query = query.eq('user_id', req.query.user_id);
    if (req.query.from) query = query.gte('created_at', req.query.from);
    if (req.query.to) query = query.lte('created_at', req.query.to);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ logs: data || [], total: count || (data ? data.length : 0), page });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch audit logs' });
  }
});

module.exports = router;
