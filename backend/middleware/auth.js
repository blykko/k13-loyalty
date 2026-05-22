'use strict';
function requireUser(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ ok: false, message: 'Non connecté.' });
}
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  res.status(403).json({ ok: false, message: 'Accès refusé.' });
}
module.exports = { requireUser, requireAdmin };
