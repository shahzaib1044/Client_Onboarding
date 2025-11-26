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

function computeRiskLevelFromScore(score) {
  if (score === null || typeof score === 'undefined') return 'UNKNOWN';
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

// GET /api/dashboard/statistics?from=&to=
router.get('/statistics', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const qFrom = parseDateSafe(req.query.from);
    const qTo = parseDateSafe(req.query.to);
    const now = dayjs();

    // default: last 6 months
    const to = qTo || now.endOf('day');
    const from = qFrom || now.subtract(6, 'month').startOf('day');

    // 1) Fetch customers in date range (for totals + trends + status counts)
    const { data: customers, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id,status,created_at')
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString());

    if (custErr) {
      console.error('Error fetching customers:', custErr);
      await auditLog(req, 'GET_STATISTICS', 'DASHBOARD', null, 'FAILURE', custErr.message);
      return res.status(500).json({ message: 'Failed fetching customers' });
    }

    const rows = customers || [];
    const totalApplications = rows.length;
    const pending = rows.filter(r => (r.status || '').toUpperCase() === 'PENDING').length;
    const approved = rows.filter(r => (r.status || '').toUpperCase() === 'APPROVED').length;
    const rejected = rows.filter(r => (r.status || '').toUpperCase() === 'REJECTED').length;
    const approvalRate = totalApplications === 0 ? 0 : Math.round((approved / totalApplications) * 10000) / 100;

    // 2) Risk distribution: fetch latest risk_scores per customer and compute level from score
    const customerIds = rows.map(r => r.id).filter(Boolean);
    // Prepare defaults
    let riskDistribution = {
      low: { count: 0, percent: 0 },
      medium: { count: 0, percent: 0 },
      high: { count: 0, percent: 0 },
      unknown: { count: 0, percent: 0 }
    };
    let riskDetails = []; // array of { customer_id, risk_score, risk_level, calculated_at }

    if (customerIds.length > 0) {
      const { data: riskRows, error: riskErr } = await supabaseAdmin
        .from('risk_scores')
        .select('customer_id, score, calculated_at')
        .in('customer_id', customerIds);

      if (riskErr) {
        console.error('Error fetching risk_scores:', riskErr);
        // continue with defaults (zero distribution)
      } else {
        // pick latest risk_scores per customer by calculated_at
        const latestByCustomer = {};
        (riskRows || []).forEach(r => {
          const cid = r.customer_id;
          const calc = r.calculated_at ? dayjs(r.calculated_at) : null;
          if (!cid) return;
          if (!latestByCustomer[cid]) latestByCustomer[cid] = r;
          else {
            const existingCalc = latestByCustomer[cid].calculated_at ? dayjs(latestByCustomer[cid].calculated_at) : null;
            if (calc && existingCalc) {
              if (calc.isAfter(existingCalc)) latestByCustomer[cid] = r;
            } else if (calc && !existingCalc) {
              latestByCustomer[cid] = r;
            }
          }
        });

        // Build riskDetails and distribution counters using the score -> level mapping
        const counters = { LOW: 0, MEDIUM: 0, HIGH: 0, UNKNOWN: 0 };

        // For each customer in the requested set, if no risk row found mark UNKNOWN
        for (const cid of customerIds) {
          const r = latestByCustomer[cid];
          const score = r && (typeof r.score !== 'undefined' && r.score !== null) ? Number(r.score) : null;
          const level = computeRiskLevelFromScore(score);
          if (level === 'HIGH') counters.HIGH++;
          else if (level === 'MEDIUM') counters.MEDIUM++;
          else if (level === 'LOW') counters.LOW++;
          else counters.UNKNOWN++;

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
      }
    }

    // 3) trendsData: group by month (YYYY-MM) using customers.created_at
    const months = [];
    const start = dayjs(from).startOf('month');
    const end = dayjs(to).endOf('month');
    let cursor = start.clone();
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

    // 4) overdueReviews: reviews where next_review_date < now AND status != 'COMPLETED'
    const nowISO = dayjs().toISOString();
    const { data: overdueRows, error: overdueErr } = await supabaseAdmin
      .from('reviews')
      .select('id,customer_id,next_review_date,status')
      .lt('next_review_date', nowISO)
      .neq('status', 'COMPLETED');

    let overdueReviews = 0;
    if (overdueErr) {
      console.error('Error fetching overdue reviews:', overdueErr);
    } else {
      overdueReviews = (overdueRows || []).length;
    }

    const result = {
      totalApplications,
      pending,
      approved,
      rejected,
      approvalRate,
      riskDistribution,
      riskDetails,   // <-- per-customer computed risk_score & risk_level
      trendsData,
      overdueReviews,
      from: from.toISOString(),
      to: to.toISOString()
    };

    await auditLog(req, 'GET_STATISTICS', 'DASHBOARD', null, 'SUCCESS');
    return res.json(result);
  } catch (err) {
    console.error('GET /statistics error', err);
    try { await auditLog(req, 'GET_STATISTICS', 'DASHBOARD', null, 'FAILURE', err.message); } catch (_) {}
    return res.status(500).json({ message: 'Failed to fetch statistics' });
  }
});

module.exports = router;
