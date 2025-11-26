// routes/index.js
const authRoutes = require('./auth');
const customerRoutes = require('./customers');
const documentRoutes = require('./documents');
const reviewRoutes = require('./reviews');
const dashboardRoutes = require('./dashboard');
const auditRoutes = require('./audit');

function registerRoutes(app) {
  app.use('/api/auth', authRoutes);
  app.use('/api/customers', customerRoutes);
  app.use('/api/documents', documentRoutes); // general document endpoints
  app.use('/api/reviews', reviewRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/audit-logs', auditRoutes);
}

module.exports = { registerRoutes };
