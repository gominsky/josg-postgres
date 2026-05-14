// middleware/auth.js
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'josg_secret';

// Helper: extrae y verifica el JWT del header Authorization
function verifyBearer(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// --- Helper: cómo fallar según el área --------------------------------------
function handleAuthFail(req, res) {
  // 1) APIs → nunca redirigimos (devolvemos JSON)
  const acceptsJson = (req.get('accept') || '').includes('application/json');
  if (
    req.originalUrl.startsWith('/api') ||
    req.originalUrl.includes('/josgmaestro/api') ||
    req.originalUrl.includes('/josgentumano/api') ||
    acceptsJson
  ) {
    return res.status(401).json({ error: 'auth_required' });
  }

  // 2) Apps móviles/estáticas → SIEMPRE a login de josgentumano
  if (
    req.originalUrl.startsWith('/josgmaestro') ||
    req.originalUrl.startsWith('/josgentumano')
  ) {
    return res.redirect('/josgentumano/login.html');
  }

  // 3) Resto de la web (EJS) → página de Acceso denegado
  return res.status(403).render('acceso_denegado', { title: 'Acceso Denegado' });
}


// --- Helpers de sesión/rol ---------------------------------------------------
function hasWebSession(req) {
  return Boolean(req.session?.usuario_id || req.session?.usuario);
}

function getRole(req) {
  return req.session?.usuario_rol || req.session?.usuario?.rol || null;
}

// --- Middlewares para VISTAS (EJS) ------------------------------------------
function isAuthenticated(req, res, next) {
  if (hasWebSession(req)) return next();
  return handleAuthFail(req, res);
}

function isAdmin(req, res, next) {
  if (!hasWebSession(req)) return handleAuthFail(req, res);
  if (getRole(req) === 'admin') return next();
  // autenticado pero sin permiso
  return res.redirect('/acceso_denegado');
}

function isDocente(req, res, next) {
  if (!hasWebSession(req)) return handleAuthFail(req, res);
  const rol = getRole(req);
  if (rol === 'docente' || rol === 'admin') return next();
  return res.redirect('/acceso_denegado');
}

// --- Middlewares para API (JSON) --------------------------------------------
function isAuthenticatedApi(req, res, next) {
  if (hasWebSession(req)) return next();
  const payload = verifyBearer(req);
  if (payload) { req.jwtPayload = payload; return next(); }
  return res.status(401).json({ error: 'auth_required' });
}

function isDocenteApi(req, res, next) {
  // 1) Sesión web
  if (hasWebSession(req)) {
    const rol = getRole(req);
    if (rol === 'docente' || rol === 'admin') return next();
    return res.status(403).json({ error: 'forbidden' });
  }
  // 2) JWT Bearer
  const payload = verifyBearer(req);
  if (!payload) return res.status(401).json({ error: 'auth_required' });
  req.jwtPayload = payload;
  const rol = (payload.role || payload.rol || '').toLowerCase();
  if (rol === 'docente' || rol === 'admin') return next();
  return res.status(403).json({ error: 'forbidden' });
}

// --- App alumno (p. ej. /mensajes/app/*) ------------------------------------
function requireAlumno(req, res, next) {
  // 1) Sesión Express (portal web)
  const idSesion = Number(req.session?.alumno_id || 0);
  if (idSesion) { req.alumno_id = idSesion; return next(); }

  // 2) JWT Bearer (app móvil)
  const payload = verifyBearer(req);
  if (!payload) return res.status(401).json({ error: 'auth_required' });

  const id = Number(
    payload.alumno_id ||
    payload.usuario?.alumno_id ||
    payload.sub ||
    0
  );
  if (!id) return res.status(401).json({ error: 'auth_required' });
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
