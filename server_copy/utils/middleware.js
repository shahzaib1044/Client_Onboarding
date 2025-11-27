const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('./supabase');
const SECRET = process.env.JWT_SECRET || 'supersecret123';

/**
 * ✅ requireAuth: verifies your own JWT token and attaches req.user
 */
function requireAuth(req, res, next) {
  if (req.method === 'OPTIONS') return next(); // allow preflight

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('auth error', err);
    return res.status(401).json({ message: 'Unauthorized' });
  }
}


/**
 * ✅ requireRole: checks user role from token
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

      const role = req.user.role.toUpperCase();
      const isAllowed = allowedRoles.map(r => r.toUpperCase()).includes(role);

      if (isAllowed) return next();

      return res.status(403).json({ message: 'Forbidden' });
    } catch (err) {
      console.error('requireRole error', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  };
}


/**
 * 🧾 auditLog: (optional) keep same implementation
 */
async function auditLog(req, actionType, entityType, entityId = null, result = 'SUCCESS', details = null) {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: req.user?.id ?? null,
      action_type: actionType,
      entity_type: entityType,
      entity_id: entityId,
      ip_address: req.ip || req.socket.remoteAddress || null,
      user_agent: req.get('user-agent') || null,
      result,
      details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('auditLog error', err);
  }
}

module.exports = { requireAuth, requireRole, auditLog };
