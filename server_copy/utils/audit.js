// utils/audit.js
const { supabaseAdmin } = require('./supabase');

/**
 * writeAudit: inserts a single audit log row. Avoid storing PII in 'details'.
 * req: Express req (may be undefined for system actions)
 * params.userId can be null for system actions.
 */
async function writeAudit({ req = null, userId = null, userRole = null, actionType, entityType, entityId = null, result = 'SUCCESS', details = null }) {
  try {
    // Trim/limit details length so logs don't store big binary or PII
    const safeDetails = details ? String(details).slice(0, 2000) : null;

    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      user_role: userRole,
      action_type: actionType,
      entity_type: entityType,
      entity_id: entityId,
      ip_address: req ? (req.ip || req.socket?.remoteAddress) : null,
      user_agent: req ? req.get('user-agent') : null,
      result,
      details: safeDetails,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    // never throw logging errors to the main flow
    console.error('writeAudit error', err);
  }
}

module.exports = { writeAudit };
