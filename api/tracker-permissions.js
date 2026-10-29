import { sessionMatchesUser } from './tracker-session.js';

export const ACCESS_ROLES = ['editor', 'viewer', 'incident_editor'];

export function createUserAuthenticator({ pool, verifySessionToken, getRequestSessionToken, internalToken, safeEqual }) {
  return async (req, res, next) => {
    try {
      if (internalToken && safeEqual(req.get('x-internal-token'), internalToken)) {
        req.isInternal = true;
        return next();
      }
      const payload = verifySessionToken(getRequestSessionToken(req));
      if (!payload) return res.status(401).json({ error: 'unauthorized' });
      const result = await pool.query(`SELECT id,login,name,role_text,telegram_id,is_superadmin,access_role,session_generation
        FROM users WHERE id=$1 AND COALESCE(is_active,true)=true`, [payload.sub]);
      if (!result.rows.length || !sessionMatchesUser(payload, result.rows[0])) return res.status(401).json({ error: 'session revoked' });
      req.user = result.rows[0]; req.isInternal = false;
      next();
    } catch (error) {
      console.error('auth middleware error:', error.code || error.name);
      res.status(500).json({ error: 'auth error' });
    }
  };
}

export function permissionsFor(user) {
  if (!user) return { editTasks: false, editIncidents: false, manageUsers: false };
  if (user.is_superadmin) return { editTasks: true, editIncidents: true, manageUsers: true };
  // Compatibility for older integrations/test fixtures; database users have access_role.
  const legacyReadOnly = /viewer|read-only|readonly|только чтение|просмотр|наблюдатель/i.test(user.role_text || '');
  const role = user.access_role ?? (legacyReadOnly ? 'viewer' : 'editor');
  return { editTasks: role === 'editor', editIncidents: role === 'editor' || role === 'incident_editor', manageUsers: false };
}

export function permissionGuard(authenticateRequest, permission) {
  return (req, res, next) => authenticateRequest(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!permissionsFor(req.user)[permission]) return res.status(403).json({ error: 'Недостаточно прав' });
    next();
  });
}
