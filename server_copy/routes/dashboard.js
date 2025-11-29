// routes/dashboard.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../utils/supabase');
const { requireAuth, requireRole, auditLog } = require('../utils/middleware');
const dayjs = require('dayjs');

// Helper: parse ISO date or return null
function parseDateSafe(d) {
  if (!d) return null;
  const dt = dayjs(d);
  return dt.isValid() ? dt.startOf('day') : null;
}

// Map score to risk level
function computeRiskLevelFromScore(score) {
  if (score === null || typeof score === 'undefined') return 'UNKNOWN';
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

router.get('/statistics', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const qFrom = parseDateSafe(req.query.from);
    const qTo = parseDateSafe(req.query.to);
    const now = dayjs();

   const from = qFrom || now.subtract(6, 'month').startOf('day');
const to = qTo || now.endOf('day');  // ensures all up to current time


    console.log(`[INFO] Fetching dashboard statistics from ${from.toISOString()} to ${to.toISOString()}`);

    // 1) Fetch customers in date range
    const { data: customers, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id,status,created_at')
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString());

    if (custErr) {
      console.error('[ERROR] Fetching customers failed:', custErr);
      await auditLog(req, 'GET_STATISTICS', 'DASHBOARD', null, 'FAILURE', custErr.message);
      return res.status(500).json({ message: 'Failed fetching customers' });
    }

    const rows = customers || [];
    console.log(`[INFO] Fetched ${rows.length} customers`);

    // Log unique statuses for debugging
    console.log('[INFO] Unique customer statuses:', [...new Set(rows.map(r => r.status))]);

    const totalApplications = rows.length;

    // Count applications by status
    const pending = rows.filter(r => (r.status || '').toUpperCase() === 'DRAFT').length;
    const approved = rows.filter(r => (r.status || '').toUpperCase() === 'APPROVED').length;
    const rejected = rows.filter(r => (r.status || '').toUpperCase() === 'REJECTED').length;
    const approvalRate = totalApplications === 0 ? 0 : Math.round((approved / totalApplications) * 10000) / 100;

    console.log('[INFO] Application counts:', { totalApplications, pending, approved, rejected, approvalRate });

    // 2) Risk distribution
    const customerIds = rows.map(r => r.id).filter(Boolean);
    let riskDistribution = {
      low: { count: 0, percent: 0 },
      medium: { count: 0, percent: 0 },
      high: { count: 0, percent: 0 },
      unknown: { count: 0, percent: 0 }
    };
    let riskDetails = [];

    if (customerIds.length > 0) {
      const { data: riskRows, error: riskErr } = await supabaseAdmin
        .from('risk_scores')
        .select('customer_id, score, calculated_at')
        .in('customer_id', customerIds);

      if (riskErr) console.error('[ERROR] Fetching risk scores failed:', riskErr);
      else console.log(`[INFO] Fetched ${riskRows.length} risk scores`);

      // Pick latest risk score per customer
      const latestByCustomer = {};
      (riskRows || []).forEach(r => {
        const cid = r.customer_id;
        const calc = r.calculated_at ? dayjs(r.calculated_at) : null;
        if (!cid) return;
        if (!latestByCustomer[cid]) latestByCustomer[cid] = r;
        else {
          const existingCalc = latestByCustomer[cid].calculated_at ? dayjs(latestByCustomer[cid].calculated_at) : null;
          if (calc && (!existingCalc || calc.isAfter(existingCalc))) latestByCustomer[cid] = r;
        }
      });

      const counters = { LOW: 0, MEDIUM: 0, HIGH: 0, UNKNOWN: 0 };
      for (const cid of customerIds) {
        const r = latestByCustomer[cid];
        const score = r && r.score != null ? Number(r.score) : null;
        const level = computeRiskLevelFromScore(score);
        counters[level] = (counters[level] || 0) + 1;

        riskDetails.push({
          customer_id: cid,
          risk_score: score,
          risk_level: level,
          calculated_at: r ? r.calculated_at : null
        });
      }

      const denom = totalApplications === 0 ? 1 : totalApplications;
      riskDistribution = {
        low: { count: counters.LOW, percent: Math.round((counters.LOW / denom) * 10000) / 100 },
        medium: { count: counters.MEDIUM, percent: Math.round((counters.MEDIUM / denom) * 10000) / 100 },
        high: { count: counters.HIGH, percent: Math.round((counters.HIGH / denom) * 10000) / 100 },
        unknown: { count: counters.UNKNOWN, percent: Math.round((counters.UNKNOWN / denom) * 10000) / 100 }
      };

      console.log('[INFO] Risk distribution:', riskDistribution);
    }

    // 3) Trends per month
    const months = [];
    let cursor = dayjs(from).startOf('month');
    const end = dayjs(to).endOf('month');
    while (cursor.isBefore(end) || cursor.isSame(end)) {
      months.push(cursor.format('YYYY-MM'));
      cursor = cursor.add(1, 'month');
    }

    const trendsData = months.map(m => {
      const [y, mm] = m.split('-');
      const count = rows.filter(r => {
        if (!r.created_at) return false;
        const ca = dayjs(r.created_at);
        return ca.year() === parseInt(y, 10) && (ca.month() + 1) === parseInt(mm, 10);
      }).length;
      return { period: m, count };
    });

    console.log('[INFO] Trends data:', trendsData);

    // 4) Overdue reviews
    const nowISO = dayjs().toISOString();
    const { data: overdueRows, error: overdueErr } = await supabaseAdmin
      .from('reviews')
      .select('id,customer_id,next_review_date,status')
      .lt('next_review_date', nowISO)
      .neq('status', 'COMPLETED');

    let overdueReviews = 0;
    if (overdueErr) console.error('[ERROR] Fetching overdue reviews failed:', overdueErr);
    else {
      overdueReviews = (overdueRows || []).length;
      console.log('[INFO] Overdue reviews count:', overdueReviews);
    }

    const result = {
      totalApplications,
      pending,
      approved,
      rejected,
      approvalRate,
      riskDistribution,
      riskDetails,
      trendsData,
      overdueReviews,
      from: from.toISOString(),
      to: to.toISOString()
    };

    console.log('[INFO] Returning statistics result');

    await auditLog(req, 'GET_STATISTICS', 'DASHBOARD', null, 'SUCCESS');
    return res.json(result);

  } catch (err) {
    console.error('[ERROR] GET /statistics error:', err);
    try { await auditLog(req, 'GET_STATISTICS', 'DASHBOARD', null, 'FAILURE', err.message); } catch (_) {}
    return res.status(500).json({ message: 'Failed to fetch statistics' });
  }
});

module.exports = router;
