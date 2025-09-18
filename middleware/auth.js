// middleware/auth.js

// --- Páginas (vistas): mantienen tu comportamiento actual ---
function isAuthenticated(req, res, next) {
  if (req.session && req.session.usuario) return next();
  res.redirect('/'); // o /login si tienes ruta
}

function isAdmin(req, res, next) {
  if (req.session?.usuario?.rol === 'admin') return next();
  res.status(403).render('acceso_denegado');
}

function isDocente(req, res, next) {
  const rol = req.session?.usuario?.rol;
  if (rol === 'docente' || rol === 'admin') return next();
  res.status(403).render('acceso_denegado');
}

// --- APIs (devuelven JSON en vez de redirigir/renderizar) ---
function isAuthenticatedApi(req, res, next) {
  if (req.session && req.session.usuario) return next();
  return res.status(401).json({ error: 'No autenticado' });
}

function isDocenteApi(req, res, next) {
  const rol = req.session?.usuario?.rol;
  if (rol === 'docente' || rol === 'admin') return next();
  return res.status(403).json({ error: 'No autorizado' });
}

// --- App alumno (para /mensajes/app/* y /mensajes/push/subscribe) ---
function requireAlumno(req, res, next) {
  const id = Number(req.session?.alumno_id || 0);
  if (!id) return res.status(401).json({ error: 'No autenticado' });
  req.alumno_id = id;
  next();
}

module.exports = {
  // vistas
  isAuthenticated,
  isAdmin,
  isDocente,
  // api
  isAuthenticatedApi,
  isDocenteApi,
  // alumno app
  requireAlumno,
};
