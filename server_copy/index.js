require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const { registerRoutes } = require('./routes');
const serverless = require('serverless-http');

const app = express();
app.set('trust proxy', 1);
// ------------------------
// CORS Setup
// ------------------------
// ------------------------
// CORS Setup
// ------------------------
const allowedOrigins = [
  'https://client-onboarding-frontend.vercel.app',
  'http://localhost:3000', // optional for local dev
];

const corsOptions = {
  origin: function(origin, callback) {
    // allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));

// Handle preflight requests manually just in case
app.options(/.*/, cors(corsOptions));


// ------------------------
// Body parser & cookies
// ------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ------------------------
// Security headers
// ------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "https://*.supabase.co"],
      },
    },
    frameguard: { action: 'deny' },
  })
);

// ------------------------
// Force HTTPS + HSTS (optional)
// ------------------------
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    if (proto !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    );
  }
  next();
});

// ------------------------
// Rate limiting
// ------------------------
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ------------------------
// CSRF Protection (optional)
// ------------------------
if (process.env.ENABLE_CSRF === 'true') {
  app.use(
    csurf({
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
      },
    })
  );

  app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });
}

// ------------------------
// Health check & root
// ------------------------
app.get('/', (req, res) => res.json({ message: 'Server is running!' }));
app.get('/health', (req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString() })
);

// ------------------------
// Register routes
// ------------------------
registerRoutes(app);

// ------------------------
// Global error handler
// ------------------------
app.use((err, req, res, next) => {
  if (err && err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ message: 'Invalid CSRF token' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

module.exports = app;
module.exports.handler = serverless(app);
