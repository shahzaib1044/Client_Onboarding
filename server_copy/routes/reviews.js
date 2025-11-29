// routes/reviews.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../utils/supabase');
const { requireAuth, requireRole, auditLog } = require('../utils/middleware');

// Helper: format Date -> YYYY-MM-DD
function toDateOnlyISO(d) {
  const date = new Date(d);
  return date.toISOString().slice(0, 10);
}
router.post('/customers/:id/approve', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    console.log(`[Approve] Received request to approve customer ID: ${customerId}`);

    if (isNaN(customerId)) {
      console.log(`[Approve] Invalid customer ID: ${req.params.id}`);
      return res.status(400).json({ message: "Invalid customer ID" });
    }

    // 1. Approve the customer and update decision_date to now
    const nowISOString = new Date().toISOString();
    console.log(`[Approve] Updating customer status to APPROVED with decision_date: ${nowISOString}`);
    const { data: customerData, error: updateError } = await supabaseAdmin
      .from('customers')
      .update({
        status: 'APPROVED',
        decision_date: nowISOString,
        approved_by: req.user.id,
      })
      .eq('id', customerId)
      .select()
      .single();

    if (updateError) {
      console.error('[Approve] Error updating customer:', updateError);
      throw updateError;
    }
    console.log(`[Approve] Customer updated:`, customerData);

    // 2. Check if any review exists already for this customer
    const { data: existingReviews, error: existingError } = await supabaseAdmin
      .from('reviews')
      .select('id')
      .eq('customer_id', customerId)
      .limit(1);

    if (existingError) {
      console.error('[Approve] Error fetching existing reviews:', existingError);
      throw existingError;
    }
    console.log(`[Approve] Found ${existingReviews.length} existing review(s) for customer`);

    // 3. Create review for this customer if none exist
    if (existingReviews.length === 0) {
      const decisionDate = new Date(customerData.decision_date);
      const reviewDate = new Date(decisionDate);
      reviewDate.setMonth(reviewDate.getMonth() + 6);
      const scheduled_date = reviewDate.toISOString().slice(0, 10);
      console.log(`[Approve] Scheduling new review for customer ${customerId} on ${scheduled_date}`);

      const { data: insertedReview, error: reviewError } = await supabaseAdmin
        .from('reviews')
        .insert({
          customer_id: customerId,
          scheduled_date,
          status: 'DRAFT',
        })
        .select()
        .single();

      if (reviewError) {
        console.error('[Approve] Error inserting review:', reviewError);
        throw reviewError;
      }
      console.log(`[Approve] Review created successfully for customer ${customerId}:`, insertedReview);
    } else {
      console.log(`[Approve] Skipping review creation for customer ${customerId} as review already exists.`);
    }

    // 4. Now backfill reviews for all other approved customers without reviews
    console.log('[Approve] Starting backfill for all approved customers missing reviews...');
    const { data: approvedCustomers, error: custError } = await supabaseAdmin
      .from('customers')
      .select('id, decision_date')
      .eq('status', 'APPROVED');

    if (custError) {
      console.error('[Approve] Error fetching approved customers:', custError);
      throw custError;
    }

    let backfillCount = 0;
    for (const customer of approvedCustomers) {
      // Skip the one already handled above
      if (customer.id === customerId) continue;

      const { data: reviews, error: revErr } = await supabaseAdmin
        .from('reviews')
        .select('id')
        .eq('customer_id', customer.id)
        .limit(1);

      if (revErr) {
        console.error(`[Approve] Error checking reviews for customer ${customer.id}:`, revErr);
        throw revErr;
      }

      if (reviews.length === 0) {
        // Schedule 6 months from decision_date (or from now if decision_date missing)
        let baseDate = customer.decision_date ? new Date(customer.decision_date) : new Date();
        baseDate.setMonth(baseDate.getMonth() + 6);
        const scheduled_date = baseDate.toISOString().slice(0, 10);

        const { error: insertErr } = await supabaseAdmin
          .from('reviews')
          .insert({
            customer_id: customer.id,
            scheduled_date,
            status: 'DRAFT',
          });

        if (insertErr) {
          console.error(`[Approve] Error inserting backfill review for customer ${customer.id}:`, insertErr);
          throw insertErr;
        }

        console.log(`[Approve] Backfill review created for customer ${customer.id} scheduled on ${scheduled_date}`);
        backfillCount++;
      }
    }

    res.json({
      message: existingReviews.length === 0
        ? `Customer approved and first review created; backfilled ${backfillCount} other customers`
        : `Customer approved (review already exists); backfilled ${backfillCount} other customers`,
    });

  } catch (err) {
    console.error('[Approve] Approval failed:', err);
    res.status(500).json({ message: "Approval failed", error: err.message });
  }
});
router.post('/backfill', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    // Fetch all approved customers
    const { data: approvedCustomers, error: customersError } = await supabaseAdmin
      .from('customers')
      .select('id, decision_date')
      .eq('status', 'APPROVED');

    if (customersError) throw customersError;

    let createdReviews = [];

    for (const customer of approvedCustomers) {
      // Check if customer already has reviews
      const { data: existingReviews, error: reviewCheckError } = await supabaseAdmin
        .from('reviews')
        .select('id')
        .eq('customer_id', customer.id)
        .limit(1);

      if (reviewCheckError) throw reviewCheckError;

      if (existingReviews.length === 0) {
        // Schedule review 6 months from decision_date
        const decisionDate = new Date(customer.decision_date);
        const reviewDate = new Date(decisionDate);
        reviewDate.setMonth(reviewDate.getMonth() + 6);
        const scheduled_date = reviewDate.toISOString().slice(0, 10);

        // Insert review
        const { data: insertedReview, error: insertError } = await supabaseAdmin
          .from('reviews')
          .insert({
            customer_id: customer.id,
            scheduled_date,
            status: 'DRAFT',
          })
          .select()
          .single();

        if (insertError) throw insertError;

        createdReviews.push(insertedReview);
      }
    }

    res.json({
      message: `Created ${createdReviews.length} new reviews for approved customers without reviews.`,
      createdReviews,
    });
  } catch (err) {
    console.error('[Backfill] Error creating reviews:', err);
    res.status(500).json({ message: "Backfill failed", error: err.message });
  }
});

router.get('/upcoming', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const { from, to } = req.query;

    // Convert today to YYYY-MM-DD (works for both DATE and TIMESTAMP columns)
    const today = new Date().toISOString().split("T")[0];

    let query = supabaseAdmin
      .from('reviews')
      .select(`
        id,
        customer_id,
        scheduled_date,
        completed_date,
        status,
        next_review_date,
        notes,
        customer:customer_id (
          id,
          first_name,
          last_name
        )
      `)
      .order('scheduled_date', { ascending: true });

    // If user doesn't provide "from", default from = today
    if (from) {
      query = query.gte('scheduled_date', from);
    } else {
      query = query.gte('scheduled_date', today);
    }

    // Apply "to" only if user provided it
    if (to) query = query.lte('scheduled_date', to);

    const { data, error } = await query;

    if (error) throw error;

    res.json({ reviews: data || [] });
  } catch (err) {
    console.error('GET /reviews/upcoming error', err);
    res.status(500).json({ message: 'Failed to fetch upcoming reviews' });
  }
});


// GET /api/reviews/overdue
router.get('/overdue', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD only

    let query = supabaseAdmin
      .from('reviews')
      .select(`
        id,
        customer_id,
        scheduled_date,
        completed_date,
        status,
        next_review_date,
        notes,
        customer:customer_id (
          id,
          first_name,
          last_name
        )
      `)
      .lt('scheduled_date', today)   // Overdue = scheduled_date < today
      .order('scheduled_date', { ascending: true });

    const { data, error } = await query;

    if (error) throw error;

    res.json({ reviews: data || [] });
  } catch (err) {
    console.error('GET /reviews/overdue error', err);
    res.status(500).json({ message: 'Failed to fetch overdue reviews' });
  }
});

// PUT /api/reviews/:id/complete
router.put('/:id/complete', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { completedDate, notes, nextReviewDate } = req.body;
    if (!completedDate) return res.status(400).json({ error: 'completedDate required' });

    // Update review status to COMPLETED and set completed_date
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .update({
        completed_date: toDateOnlyISO(completedDate),
        notes: notes || null,
        next_review_date: nextReviewDate ? toDateOnlyISO(nextReviewDate) : null,
        status: 'COMPLETED',
        completed_by: req.user.id
      })
      .eq('id', id)
      .select();

    if (error || !data || data.length === 0) return res.status(404).json({ error: 'Review not found' });

    // Audit
    await auditLog(req, 'COMPLETE_REVIEW', 'REVIEW', id, 'SUCCESS');

    // Auto-create next review if nextReviewDate provided
    if (nextReviewDate) {
      const insertResp = await supabaseAdmin.from('reviews').insert({
        customer_id: data[0].customer_id,
        scheduled_date: toDateOnlyISO(nextReviewDate),
        status: 'DRAFT',

        created_at: new Date().toISOString()
      });
      if (insertResp.error) console.error('Failed to auto-create next review', insertResp.error);
    }

    res.json({ review: data[0] });
  } catch (err) {
    console.error('PUT /reviews/:id/complete error', err);
    res.status(500).json({ message: 'Failed to complete review' });
  }
});

// GET /api/customers/:id/reviews
router.get('/customers/:id/reviews', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    const { data, error } = await supabaseAdmin
      .from('reviews')
      .select(`*, customer:customer_id (first_name, last_name)`)
      .eq('customer_id', customerId)
      .order('scheduled_date', { ascending: false });

    if (error) throw error;
    res.json({ reviews: data || [] });
  } catch (err) {
    console.error('GET /customers/:id/reviews error', err);
    res.status(500).json({ message: 'Failed to fetch reviews' });
  }
});
// GET /api/reviews/customer/:id
router.get('/customer/:id', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    if (isNaN(customerId)) return res.status(400).json({ message: 'Invalid customer ID' });

    const { data, error } = await supabaseAdmin
      .from('reviews')
      .select('id, completed_date, notes, scheduled_date')
      .eq('customer_id', customerId)
      .neq('notes', null)           // only reviews with notes
      .order('completed_date', { ascending: false });

    if (error) throw error;

    res.json({ pastReviews: data || [] });
  } catch (err) {
    console.error('GET /reviews/customer/:id error', err);
    res.status(500).json({ message: 'Failed to fetch past reviews' });
  }
});

// DEV/Admin: Run scheduler to auto-create next-review for approved customers that lack a future review
// POST /api/admin/run-review-scheduler  (protected)
router.post('/admin/run-review-scheduler', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    // Find approved customers
    const { data: customers, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, decision_date')
      .eq('status', 'APPROVED');

    if (custErr) throw custErr;

    const created = [];

    for (const c of customers || []) {
      // compute default next review = decision_date + 6 months
      const base = c.decision_date ? new Date(c.decision_date) : new Date();
      const next = new Date(base);
      next.setMonth(next.getMonth() + 6);
      const scheduled_date = toDateOnlyISO(next);

      // check if there is any pending/future review for that customer
      const { data: existing } = await supabaseAdmin
        .from('reviews')
        .select('id')
        .eq('customer_id', c.id)
        .gte('scheduled_date', toDateOnlyISO(new Date()))
        .limit(1);

      if (!existing || existing.length === 0) {
        const { error: insErr } = await supabaseAdmin.from('reviews').insert({
          customer_id: c.id,
          scheduled_date,
          status: 'DRAFT',
         
          created_at: new Date().toISOString()
        });
        if (!insErr) created.push({ customer_id: c.id, scheduled_date });
        else console.error('Scheduler insert error for', c.id, insErr);
      }
    }

    res.json({ created });
  } catch (err) {
    console.error('POST /admin/run-review-scheduler error', err);
    res.status(500).json({ error: 'Scheduler failed' });
  }
});

module.exports = router;
