import express from "express";
import bcrypt from "bcrypt";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import jwt from 'jsonwebtoken';

dotenv.config();

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Simple email format validator
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { email, password, role } = req.body;

    // Check required fields
    if (!email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Check if email already exists
    const { data: existingUser, error: fetchError } = await supabase
      .from("users")
      .select("email")
      .eq("email", email)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (existingUser) {
      return res.status(409).json({ error: "Email already registered" });
    }

    // Hash password securely
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Insert new user
    const { data, error } = await supabase
      .from("users")
      .insert([{ email, password_hash, role }])
      .select();

    if (error) throw error;

    res.status(201).json({
      message: "Account created successfully",
      user: data[0],
    });

  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});
// Auth.js


const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const SESSION_TIMEOUT_MINUTES = 30;

// Rate limiter: max 5 attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper login function
async function handleLogin(req, res, expectedRole) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .eq('role', expectedRole)
      .maybeSingle();

    if (error) throw error;
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

    // Create JWT payload with user id and role
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: `${SESSION_TIMEOUT_MINUTES}m` }
    );

    res.json({ token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

router.post('/customer/login', loginLimiter, (req, res) => handleLogin(req, res, 'CUSTOMER'));
router.post('/employee/login', loginLimiter, (req, res) => handleLogin(req, res, 'EMPLOYEE'));
export default router;
