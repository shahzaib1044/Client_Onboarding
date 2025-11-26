// routes/customers.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../utils/supabase');
const { requireAuth, requireRole, auditLog } = require('../utils/middleware');
const { calculateRiskScore } = require('../utils/calculateRisk');
const bcrypt = require('bcrypt');
// GET /api/customers? page/limit/filter...  (EMPLOYEE)
// GET /api/customers? page/limit/filter...  (EMPLOYEE)
router.get('/', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '20');
    const offset = (page - 1) * limit;
    const sort = req.query.sort || 'registrationDate';
    const order = req.query.order || 'desc';

    const statusFilter = req.query.status && req.query.status !== 'ALL' ? req.query.status : null;
    const riskFilter = req.query.risk && req.query.risk !== 'ALL' ? req.query.risk : null;
    const fromDate = req.query.fromDate || null;
    const toDate = req.query.toDate || null;
    const searchQuery = req.query.q?.trim().toLowerCase() || null;

    // Base query
    let query = supabaseAdmin
      .from('customers')
      .select(`
        id,
        user_id,
        first_name,
        last_name,
        status,
        created_at,
        updated_at,
        users:users!customers_user_id_fkey(email)
      `, { count: 'exact' })
      .range(offset, offset + limit - 1);

    // Apply filters on customers table
    if (statusFilter) query = query.eq('status', statusFilter);
    if (fromDate) query = query.gte('created_at', fromDate);
    if (toDate) query = query.lte('created_at', toDate);

    // Search only on first_name and last_name
    if (searchQuery) {
      const pattern = `%${searchQuery}%`;
      query = query.or(`first_name.ilike.'${pattern}',last_name.ilike.'${pattern}'`);
    }

    // Apply sorting
    if (sort === 'Customer_Name') {
      query = query.order('first_name', { ascending: order === 'asc' })
                   .order('last_name', { ascending: order === 'asc' });
    } else if (sort === 'registrationDate') {
      query = query.order('created_at', { ascending: order === 'asc' });
    } else {
      query = query.order(sort, { ascending: order === 'asc' });
    }

    const { data: customers, count, error } = await query;
    if (error) throw error;

    // Apply risk filter and email search in JS
    const customersWithRisk = await Promise.all((customers || []).map(async (c) => {
      const { data: riskData } = await supabaseAdmin
        .from('risk_scores')
        .select('*')
        .eq('customer_id', c.id)
        .single();

      const riskScore = riskData?.score ?? null;
      const riskLevel = riskData?.level ?? (riskScore >= 70 ? 'HIGH' : riskScore >= 40 ? 'MEDIUM' : 'LOW');

      // Filter by risk
      if (riskFilter && riskLevel !== riskFilter) return null;

      // Filter by email if searchQuery exists
      if (searchQuery && c.users?.email?.toLowerCase().includes(searchQuery)) {
        return {
          id: c.id,
          customerName: `${c.first_name} ${c.last_name}`,
          email: c.users?.email || '-',
          status: c.status,
          registrationDate: c.created_at,
          updated_at: c.updated_at,
          risk_score: riskScore,
          risk_level: riskLevel,
          risk_breakdown: riskData?.breakdown ?? null
        };
      }

      // Include if first_name/last_name matched Supabase search
      return {
        id: c.id,
        customerName: `${c.first_name} ${c.last_name}`,
        email: c.users?.email || '-',
        status: c.status,
        registrationDate: c.created_at,
        updated_at: c.updated_at,
        risk_score: riskScore,
        risk_level: riskLevel,
        risk_breakdown: riskData?.breakdown ?? null
      };
    }));

    const filteredCustomers = customersWithRisk.filter(c => c); // remove nulls

    await auditLog(req, 'GET_CUSTOMERS', 'CUSTOMER', null, 'SUCCESS');

    res.json({
      customers: filteredCustomers,
      total: filteredCustomers.length,
      page,
      totalPages: Math.ceil(filteredCustomers.length / limit)
    });
  } catch (err) {
    console.error(err);
    await auditLog(req, 'GET_CUSTOMERS', 'CUSTOMER', null, 'FAILURE', err.message);
    res.status(500).json({ message: 'Failed to fetch customers' });
  }
});



// GET /api/customers/search?q=
router.get('/search', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return res.json({ customers: [], count: 0 });

    const { data, error, count } = await supabaseAdmin
      .from('customers')
      .select('*', { count: 'exact' })
      .ilike('first_name', `%${q}%`)
      .or(`last_name.ilike.%${q}%,email.ilike.%${q}%`)
      .limit(50);

    if (error) throw error;
    res.json({ customers: data || [], count: count || (data ? data.length : 0) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Search failed' });
  }
});

// GET /api/customers/me  (CUSTOMER)
router.get('/me', requireAuth, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const { data: customer, error } = await supabaseAdmin.from('customers').select('*').eq('user_id', req.user.id).single();
    if (error) return res.status(404).json(null);
    res.json(customer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch application' });
  }
});

// GET /api/customers/:id  (EMPLOYEE, OWNER, or customer himself)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    if (isNaN(customerId)) {
      return res.status(400).json({ message: "Invalid customer ID" });
    }

    // Fetch the customer with user email
    const { data: customer, error: custError } = await supabaseAdmin
      .from('customers')
      .select(`
        id,
        user_id,
        first_name,
        last_name,
        status,
        created_at,
        updated_at,
        date_of_birth,
        phone,
        address_line1,
        city,
        postal_code,
        country,
        annual_income,
        employment_status,
        account_type,
        initial_deposit,
        id_number,
        users:users!customers_user_id_fkey(email)
      `)
      .eq('id', customerId)
      .single();

    if (custError || !customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Determine role of logged in user
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();

    const role = profile?.role || req.user?.rawUser?.user_metadata?.role;

    // Access control: Only EMPLOYEE / OWNER or the customer himself
    const isOwner = req.user.id === customer.user_id;
    if (role === "CUSTOMER" && !isOwner) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Fetch risk score
    const { data: riskData } = await supabaseAdmin
      .from('risk_scores')
      .select('*')
      .eq('customer_id', customer.id)
      .single();

    const riskScore = riskData?.score ?? null;
    const riskLevel = riskData?.risk_level ??
      (riskScore >= 70 ? "HIGH" :
       riskScore >= 40 ? "MEDIUM" : "LOW");

    const riskBreakdown = riskData ? {
      age_factor: riskData.age_factor,
      income_factor: riskData.income_factor,
      employment_factor: riskData.employment_factor,
      account_type_factor: riskData.account_type_factor,
      deposit_factor: riskData.deposit_factor
    } : null;

    // Build formatted customer response
    const formattedCustomer = {
      id: customer.id,
      customerName: `${customer.first_name} ${customer.last_name}`,
      email: customer.users?.email || "-",
      status: customer.status,
      registrationDate: customer.created_at,
      updated_at: customer.updated_at,
      date_of_birth: customer.date_of_birth,
      phone: customer.phone,
      address_line1: customer.address_line1,
      city: customer.city,
      postal_code: customer.postal_code,
      country: customer.country,
      annual_income: customer.annual_income,
      employment_status: customer.employment_status,
      account_type: customer.account_type,
      initial_deposit: customer.initial_deposit,
      id_number: customer.id_number,
      risk_score: riskScore,
      risk_level: riskLevel,
      risk_breakdown: riskBreakdown
    };

    res.json(formattedCustomer);

  } catch (err) {
    console.error("Error fetching customer:", err);
    res.status(500).json({ message: 'Failed to fetch customer' });
  }
});


// POST /api/customers (customer creates application)
router.post('/', requireAuth, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const payload = { ...req.body, user_id: req.user.id, status: 'DRAFT', created_at: new Date().toISOString() };
    const { data, error } = await supabaseAdmin.from('customers').insert(payload).select().single();
    if (error) throw error;

    // calculate risk and store
    const risk = calculateRiskScore(data);
    await supabaseAdmin.from('risk_scores').insert({ customer_id: data.id, ...risk, created_at: new Date().toISOString() });

    await auditLog(req, 'CREATE_APPLICATION', 'CUSTOMER', data.id, 'SUCCESS');
    res.status(201).json(data);
  } catch (err) {
    console.error(err);
    await auditLog(req, 'CREATE_APPLICATION', 'CUSTOMER', null, 'FAILURE', err.message);
    res.status(500).json({ message: 'Failed to create application' });
  }
});

// POST /api/customers/:id/submit (customer submits application)
router.post('/:id/submit', requireAuth, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { data: customer } = await supabaseAdmin.from('customers').select('*').eq('id', id).single();
    if (!customer) return res.status(404).json({ message: 'Not found' });
    if (customer.user_id !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    const { error } = await supabaseAdmin.from('customers').update({ status: 'PENDING', submitted_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;

    await auditLog(req, 'SUBMIT_APPLICATION', 'CUSTOMER', id, 'SUCCESS');
    res.json({ message: 'Submitted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Submit failed' });
  }
});

// PUT /api/customers/:id  (update)
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // fetch customer
    const { data: customer } = await supabaseAdmin
      .from('customers')
      .select('*')
      .eq('id', id)
      .single();
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    // only owner or employee can update
    const isOwner = customer.user_id === req.user.id;
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();
    const role = profile?.role || req.user.rawUser?.user_metadata?.role;
    if (role === 'CUSTOMER' && !isOwner) return res.status(403).json({ message: 'Forbidden' });

    const updatePayload = { ...req.body };

    // ---- PASSWORD HANDLING ----
    if (updatePayload.password && updatePayload.currentPassword) {
      // fetch user
      const { data: user } = await supabaseAdmin
        .from('users')
        .select('id, password_hash')
        .eq('id', customer.user_id)
        .single();

      if (!user) return res.status(404).json({ message: 'User not found' });

      // verify current password
      const isMatch = await bcrypt.compare(updatePayload.currentPassword, user.password_hash);
      if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect' });

      // hash new password
      const hashed = await bcrypt.hash(updatePayload.password, 10);

      // update users table
      const { error: pwError } = await supabaseAdmin
        .from('users')
        .update({ password_hash: hashed })
        .eq('id', user.id);
      if (pwError) throw pwError;

      // remove password fields so customers table is not affected
      delete updatePayload.password;
      delete updatePayload.currentPassword;
    }

    // update customer table (all other fields)
    const { data, error } = await supabaseAdmin
      .from('customers')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await auditLog(req, 'UPDATE_CUSTOMER', 'CUSTOMER', id, 'SUCCESS');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update' });
  }
});

// PUT /api/customers/:id/approve (EMPLOYEE)
router.put('/:id/approve', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { data, error } = await supabaseAdmin.from('customers').update({ status: 'APPROVED', decision_date: new Date().toISOString() }).eq('id', id).select().single();
    if (error) return res.status(500).json({ message: 'Failed to approve' });

    await auditLog(req, 'APPROVE_APPLICATION', 'CUSTOMER', id, 'SUCCESS');
    res.json({ message: 'Approved', customer: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to approve' });
  }
});

// PUT /api/customers/:id/reject (EMPLOYEE)
router.put('/:id/reject', requireAuth, requireRole('EMPLOYEE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason || reason.length < 10) return res.status(400).json({ error: 'Reason required (min 10 chars)' });

    const { data, error } = await supabaseAdmin.from('customers').update({ status: 'REJECTED', decision_date: new Date().toISOString(), rejection_reason: reason }).eq('id', id).select().single();
    if (error) return res.status(500).json({ message: 'Failed to reject' });

    await auditLog(req, 'REJECT_APPLICATION', 'CUSTOMER', id, 'SUCCESS', reason);
    res.json({ message: 'Rejected', customer: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to reject' });
  }
});

// POST /api/customers/:id/calculate-risk (EMPLOYEE/System)
// POST /calculate-risk (upsert)
router.post('/:id/calculate-risk', requireAuth, requireRole('CUSTOMER','EMPLOYEE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { data: customer } = await supabaseAdmin.from('customers')
      .select('*')
      .eq('id', id)
      .single();
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    const risk = calculateRiskScore(customer);

    const { data: inserted, error } = await supabaseAdmin.from('risk_scores')
      .upsert({ customer_id: id, ...risk }, { onConflict: ['customer_id'] }) // ✅ prevents duplicate key
      .select()
      .single();

    if (error) throw error;
    await auditLog(req, 'CALCULATE_RISK', 'CUSTOMER', id, 'SUCCESS');

    res.json({ riskScore: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Risk calculation failed' });
  }
});

// GET /api/customers/:id/risk-score (EMPLOYEE)
// GET /risk-score (always try to return a risk score if exists)
router.get('/:id/risk-score', requireAuth, requireRole('CUSTOMER','EMPLOYEE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { data, error } = await supabaseAdmin.from('risk_scores')
      .select('*')
      .eq('customer_id', id)
      .single();

    if (error || !data) return res.status(404).json({ message: 'Not found' });

    res.json({ riskScore: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch risk score' });
  }
});

// GET /api/customers/:id/history (status changes / audit sample)
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // get audit logs for this customer
    const { data, error } = await supabaseAdmin.from('audit_logs').select('*').eq('entity_type', 'CUSTOMER').eq('entity_id', id).order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ history: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch history' });
  }
});
router.get('/search',  requireAuth, requireRole('EMPLOYEE'), async (req,res) => {
  const q = req.query.q || '';
  const like = `%${q}%`;
  const rows = await Customer.findAll({ where: {
    [Op.or]: [
      { first_name: { [Op.like]: like } },
      { last_name: { [Op.like]: like } },
      { id_number: { [Op.like]: like } }
    ]
  }, include: [ { model:User, attributes:['email'] }, { model: RiskScore } ], limit: 50 });
  const customers = rows.map(r => ({ id: r.id, first_name: r.first_name, last_name: r.last_name, email: r.User?.email, score: r.RiskScore?.score }));
  res.json({ customers, count: customers.length });
});
// routes/customers.js



module.exports = router;
