// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const csurf = require('csurf'); // optional: enable only if using cookie-based auth
const { registerRoutes } = require('./routes'); // routes/index.js
const serverless = require("serverless-http");
const app = express();

// Basic middleware
const corsOptions = {
  origin: 'https://client-onboarding-frontend.vercel.app', // frontend URL
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true, // if you use cookies
};

app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Security headers via Helmet (CSP example - tweak for your frontend)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'","'unsafe-inline'"],
      imgSrc: ["'self'","data:"],
      connectSrc: ["'self'","https://*.supabase.co"],
    }
  },
  frameguard: { action: 'deny' } // X-Frame-Options: DENY
}));

// Force HTTPS + HSTS in production (infra preferred; this is fallback)
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    // If behind reverse proxy (e.g., nginx) set 'x-forwarded-proto' header
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    if (proto !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    // HSTS header
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

// Rate limiting - global
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // requests per IP per window
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Stricter rate-limits for auth endpoints (apply only to login/forgot-password)
// You can use route-specific middleware in routes/auth.js, example:
// const authLimiter = rateLimit({ windowMs: 60*1000, max: 10 });
// app.use('/api/auth/login', authLimiter);

// Optional: CSRF protection (only enable if you use cookie-based auth/session cookies)
const enableCsrf = process.env.ENABLE_CSRF === 'true';
if (enableCsrf) {
  // store CSRF token in httpOnly cookie, and expect a header or form field _csrf
  app.use(csurf({ cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' } }));

  // Endpoint to get CSRF token for client (client fetches and includes it on forms)
  app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });
}
app.get('/', (req, res) => {
  res.json({ message: 'Server is running!' });
});

// Basic health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Register all routes
registerRoutes(app);

// Global error handler
app.use((err, req, res, next) => {
  // csurf error handling example
  if (err && err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ message: 'Invalid CSRF token' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});
module.exports = app;  
module.exports.handler = serverless(app);