const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      restaurant_id: user.restaurant_id,
      role: user.role,
      name: user.name,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Every tenant-scoped route must pass through this: super_admin can act on
// behalf of any restaurant, everyone else is pinned to their own tenant.
function tenantId(req) {
  return req.user.role === 'super_admin' ? req.query.restaurant_id || req.body.restaurant_id : req.user.restaurant_id;
}

function scopeTenant(req, res, next) {
  const id = tenantId(req);
  if (!id) return res.status(400).json({ error: 'restaurant_id is required' });
  req.restaurantId = Number(id);
  next();
}

module.exports = { signToken, requireAuth, requireRole, tenantId, scopeTenant };
