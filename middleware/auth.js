// middleware/auth.js

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
  return res.status(401).json({ error: 'auth_required' });
}

function isDocenteApi(req, res, next) {
  if (!hasWebSession(req)) return res.status(401).json({ error: 'auth_required' });
  const rol = getRole(req);
  if (rol === 'docente' || rol === 'admin') return next();
  return res.status(403).json({ error: 'forbidden' });
}

// --- App alumno (p. ej. /mensajes/app/*) ------------------------------------
function requireAlumno(req, res, next) {
  const id = Number(req.session?.alumno_id || 0);
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
