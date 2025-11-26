// routes/auth.js
const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { supabaseAdmin } = require('../utils/supabase');
const { requireAuth, auditLog } = require('../utils/middleware');
const rateLimit =require('express-rate-limit');

/**
 * POST /api/auth/register
 * Note: we create user via admin.createUser and create profile in `profiles` table
 */


// or import your DB pool if using MySQL/PostgreSQL directly

router.post('/register', async (req, res) => {
  const {
    email,
    password,
    firstName,
    lastName,
    dateOfBirth,
    phone,
    address,
    city,
    postalCode,
    country,
    idNumber,
    annualIncome,
    employmentStatus,
    accountType,
    initialDeposit,
  } = req.body;
  // Accept either accountType or role from client and normalize
const rawRole = (accountType || req.body.role || '').toString().trim();
const role = rawRole.toUpperCase() === 'EMPLOYEE' ? 'EMPLOYEE' : 'CUSTOMER';

  // Basic validations
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    // ✅ Check if email already exists
    const { data: existingUser, error: checkErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email);

    if (checkErr) throw checkErr;

    if (existingUser.length > 0) {
      return res.status(409).json({ message: 'Email already exists', error: 'EMAIL_EXISTS' });
    }

    // ✅ Hash password before saving
    const passwordHash = await bcrypt.hash(password, 10);

    // ✅ Insert user into `users` table
    const { data: userInserted, error: insertErr } = await supabaseAdmin
      .from('users')
      .insert([
        {
          email,
          password_hash: passwordHash,
          // role: 'CUSTOMER',
          role: role,
          created_at: new Date().toISOString(),
          is_active: true,
        },
      ])
      .select('id')
      // .single();

    if (insertErr) throw insertErr;
    // const userId = userInserted.id;
   const userId =
  (Array.isArray(userInserted) && userInserted.length > 0 && userInserted[0].id) ||
  (userInserted && userInserted.id) ||
  null;

// If customer -> insert into customers; if employee -> only users table
   if (role === 'EMPLOYEE') {
  await auditLog(
    { user: { id: userId } },
    'REGISTER',
    'EMPLOYEE',
    null,
    'SUCCESS',
    `Created employee ${email}`
  );

     // return early so we DO NOT attempt to insert into `customers` (which requires first_name, etc.)
  return res.status(201).json({
    userId,
    message: 'Employee account created.',
    referenceNumber: `REF-${Date.now()}`
  });
}
    // ✅ Insert into `customers` table (linked to `users`)
    const { error: customerInsertErr } = await supabaseAdmin
      .from('customers')
      .insert({
        user_id: userId,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: dateOfBirth,
        phone,
        address_line1: address,
        city,
        postal_code: postalCode,
        country,
        id_number: idNumber,
        annual_income: annualIncome,
        employment_status: employmentStatus,
        account_type: accountType,
        initial_deposit: initialDeposit,
        status: 'DRAFT',
        created_at: new Date().toISOString(),
      });

    if (customerInsertErr) {
      // Rollback user if customer insert fails
      await supabaseAdmin.from('users').delete().eq('id', userId);
      throw customerInsertErr;
    }
    await auditLog({ user: { id: userId } }, 'REGISTER', 'USER', null, 'SUCCESS', `Created user ${email}`);
    // ✅ Success response
    res.status(201).json({
      userId,
      message: 'Registration successful! Your application is being reviewed.',
      referenceNumber: `REF-${Date.now()}`,
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({
      message: 'Registration failed',
      error: err.message,
    });
  }
});

router.get('/check-email', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    const exists = !!data;
    return res.status(200).json({ exists });
  } catch (err) {
    console.error('Error checking email:', err.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * Check if a user ID already exists
 * GET /api/check-id?id=123
 */
router.get('/check-id', async (req, res) => {
  const { id_number } = req.query;

  if (!id_number) {
    return res.status(400).json({ message: 'ID is required' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id_number')
      .eq('id_number', id_number)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    const exists = !!data;
    return res.status(200).json({ exists });
  } catch (err) {
    console.error('Error checking ID:', err.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
});





/**
 * POST /api/auth/login
 * NOTE: preferred flow: client calls supabase client signIn. But here we support server-side validate via /token endpoint
 * This endpoint attempts to sign-in via Supabase REST auth token endpoint by verifying credentials with Admin client:
 */


// 🔒 Rate Limiter (5 attempts per 15 minutes per IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
});

const jwt = require('jsonwebtoken');


const JWT_SECRET = process.env.JWT_SECRET ; 

async function handleLogin(req, res, role) {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    // 🔍 Get user from your "users" table
    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('email', email)
      .limit(1);

    if (error || !users || users.length === 0)
      return res.status(401).json({ error: 'Invalid credentials' });

    const user = users[0];

    // 🔐 Compare hashed password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch)
      return res.status(401).json({ error: 'Invalid credentials' });

    // 👥 Check role
    if (user.role?.toUpperCase() !== role.toUpperCase())
      return res.status(403).json({ error: `User not authorized as ${role}` });

    // ✅ Create JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    await auditLog(req, 'LOGIN', 'USER', user.id, 'SUCCESS');

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
}
router.post('/customer/login', loginLimiter, (req, res) => handleLogin(req, res, 'CUSTOMER'));
router.post('/employee/login', loginLimiter, (req, res) => handleLogin(req, res, 'EMPLOYEE'));

   
/**
 * POST /api/auth/logout
 * Accepts Bearer token; we call supabaseAdmin.auth.signOut not available in admin; instead revoke refresh tokens
 */
router.post('/logout', requireAuth, async (req, res) => {
  try {
    // Revoke all refresh tokens for this user (service role)
    const userId = req.user.id;
    await supabaseAdmin.auth.admin.invalidateUserRefreshTokens(userId);
    await auditLog(req, 'LOGOUT', 'USER', userId, 'SUCCESS');
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('logout error', err);
    await auditLog(req, 'LOGOUT', 'USER', req.user?.id, 'FAILURE', err.message);
    res.status(500).json({ message: 'Logout failed' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', req.user.id).single();
    const profile = (!error && data) ? data : null;
    res.json({ user: { id: req.user.id, email: req.user.email, profile } });
  } catch (err) {
    console.error('me error', err);
    res.status(500).json({ message: 'Failed to fetch user' });
  }
});

/**
 * POST /api/auth/forgot-password
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });

    // Use Supabase to send reset email:
    const { data, error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo: process.env.PASSWORD_RESET_REDIRECT || null
    });

    if (error) {
      console.error('forgot-password error', error);
      return res.status(500).json({ message: 'Failed to send reset email' });
    }

    res.json({ message: 'Password reset email sent if account exists' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to process request' });
  }
});

/**
 * POST /api/auth/reset-password
 * Body: { accessToken, newPassword }
 * (Supabase expects the accessToken from the link)
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { accessToken, newPassword } = req.body;
    if (!accessToken || !newPassword) return res.status(400).json({ message: 'Invalid payload' });

    // Update user password using the access token
    const { data, error } = await supabaseAdmin.auth.updateUser(accessToken, { password: newPassword });
    if (error) {
      console.error('reset-password error', error);
      return res.status(400).json({ message: 'Failed to reset password' });
    }

    res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to reset password' });
  }
});

module.exports = router;
