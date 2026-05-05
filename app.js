// node database/init.js --reset --yes  ***resetea BD Completa

const express      = require('express');
const session      = require('express-session');
const PgStore      = require('connect-pg-simple')(session);
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const app          = express();
const path         = require('path');
const db           = require('./database/db');
const expressLayouts = require('express-ejs-layouts');
const methodOverride = require('method-override');
const fs           = require('fs');
require('dotenv').config();
const { isAuthenticated, isAdmin, isDocente } = require('./middleware/auth');

// ─── Validación de variables críticas al arrancar ────────────────
if (!process.env.SESSION_SECRET) {
  throw new Error('[BOOT] SESSION_SECRET no está definido. Revisa tu archivo .env');
}
if (!process.env.JWT_SECRET) {
  throw new Error('[BOOT] JWT_SECRET no está definido. Revisa tu archivo .env');
}

// ─── Logs de proceso ─────────────────────────────────────────────
process.on('beforeExit',        (code) => console.log('[proc] beforeExit code=', code));
process.on('exit',              (code) => console.log('[proc] exit code=', code));
process.on('uncaughtException', (err)  => console.error('[proc] uncaughtException:', err));
process.on('unhandledRejection',(reason) => console.error('[proc] unhandledRejection:', reason));

app.set('trust proxy', 1);

// ─── Seguridad HTTP (helmet) ──────────────────────────────────────
// Añade cabeceras: X-Frame-Options, X-Content-Type-Options, HSTS, etc.
app.use(helmet({
  contentSecurityPolicy: false, // desactivado para no romper EJS/inline scripts; actívalo cuando tengas el host definitivo
  crossOriginEmbedderPolicy: false
}));

// ─── Rate limiting en login ───────────────────────────────────────
// Máximo 10 intentos de login por IP cada 15 minutos
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos de acceso. Espera 15 minutos e inténtalo de nuevo.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV !== 'production' // solo activo en producción
});

// ─── Parsers ──────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

// ─── Sesión ───────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET,
  store: new PgStore({
    db,
    tableName: 'session',
    createTableIfMissing: true
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// ─── Variables de sesión disponibles para TODAS las rutas ─────────
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  res.locals.error   = req.session.error   || null;
  delete req.session.error;
  next();
});

app.use((req, res, next) => {
  res.locals.mensaje = req.session.mensaje || null;
  delete req.session.mensaje;
  next();
});

// ─── Compuerta temprana para API (nunca redirige) ─────────────────
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/josgmaestro/api')) {
    if (req.headers.authorization) return next();
    if (!req.session?.usuario_id) {
      return res.status(401).json({ error: 'auth_required' });
    }
  }
  return next();
});

// ─── Guard para páginas estáticas de /josgmaestro ─────────────────
function requireAuthPage(req, res, next) {
  if (req.path.startsWith('/api')) return next();
  const isAsset = /\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|map)$/.test(req.path);
  const isLogin = req.path === '/' || req.path === '/index.html';
  if (isAsset || isLogin) return next();
  if (req.session?.usuario_id) return next();
  return res.redirect('/josgmaestro/index.html');
}

// ─── Plantillas EJS ───────────────────────────────────────────────
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Función global para fechas
app.locals.formatDate = (isoString) => {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (isNaN(date)) return isoString;
  return date.toLocaleDateString('es-ES');
};

// ─── Directorio de uploads ────────────────────────────────────────
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
console.log('[BOOT] UPLOADS_DIR =', UPLOADS_DIR);
try {
  fs.accessSync(UPLOADS_DIR, fs.constants.W_OK);
  console.log('[BOOT] UPLOADS_DIR es ESCRITURABLE');
} catch (e) {
  console.error('[BOOT] UPLOADS_DIR NO es escribible:', e.message);
}
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',
  dotfiles: 'deny',
  fallthrough: false
}));

// ─── Estáticos públicos ───────────────────────────────────────────
app.use('/eventos/styles', express.static(path.join(__dirname, 'public', 'styles')));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rutas ───────────────────────────────────────────────────────
const josgmaestroRouter = require('./routes/josgmaestro');
app.use('/josgmaestro', josgmaestroRouter);
app.use('/josgmaestro', requireAuthPage, express.static(path.join(__dirname, 'public/josgmaestro')));

const authRoutes = require('./routes/auth');
app.use(loginLimiter, authRoutes); // rate limiting aplicado al login

app.get(
  ['/josgentumano/mensajes.html', '/firmas/mensajes.html', '/mensajes.html'],
  (req, res) => res.redirect(302, '/josgentumano/login.html')
);

const authUnificado       = require('./routes/auth_unificado');
const baremosRouter       = require('./routes/baremos');
const usuariosRoutes      = require('./routes/usuarios');
const profesoresRoutes    = require('./routes/profesores');
const alumnosRoutes       = require('./routes/alumnos');
const gruposRoutes        = require('./routes/grupos');
const cuotasRoutes        = require('./routes/cuotas');
const eventosRoutes       = require('./routes/eventos');
const firmasRoutes        = require('./routes/firmas');
const informesRoutes      = require('./routes/informes');
const guardiasRoutes      = require('./routes/guardias');
const instrumentosRoutes  = require('./routes/instrumentos');
const tipos_cuotasRoutes  = require('./routes/tipos_cuotas');
const pagosRoutes         = require('./routes/pagos');
const configuracionRoutes = require('./routes/configuracion');
const planoRoutes         = require('./routes/plano');
const contabilidadRoutes  = require('./routes/contabilidad');
const proveedoresRoutes   = require('./routes/proveedores');
const categoriasRoutes    = require('./routes/categorias');
const cuentasRoutes       = require('./routes/cuentas');
const recuperarRoutes     = require('./routes/recuperar');
const pdfRoutes           = require('./routes/pdf');
const layoutsRoutes       = require('./routes/layouts');
const ausenciasRoutes     = require('./routes/ausencias');
const actividadesRoutes   = require('./routes/actividades_complementarias');
const espaciosRoutes      = require('./routes/espacios');
const partiturasRoutes    = require('./routes/partituras');
const plantillasRoutes    = require('./routes/plantillas');
const mensajesRoutes      = require('./routes/mensajes');
const atrilRoutes         = require('./routes/atril');

app.use('/auth',          loginLimiter, authUnificado); // rate limiting en auth unificado
app.use('/baremos',       baremosRouter);
app.use('/configuracion', isAdmin, configuracionRoutes);
app.use('/usuarios',      isAuthenticated, usuariosRoutes);
app.use('/profesores',    isAuthenticated, profesoresRoutes);
app.use('/alumnos',       isAuthenticated, alumnosRoutes);
app.use('/grupos',        isAdmin, gruposRoutes);
app.use('/cuotas',        isAdmin, cuotasRoutes);
app.use('/eventos',       isAuthenticated, eventosRoutes);
app.use('/informes',      isAuthenticated, informesRoutes);
app.use('/firmas',        firmasRoutes);
app.use('/guardias',      isAuthenticated, guardiasRoutes);
app.use('/instrumentos',  isAdmin, instrumentosRoutes);
app.use('/tipos_cuotas',  isAdmin, tipos_cuotasRoutes);
app.use('/pagos',         isAdmin, pagosRoutes);
app.use('/plano',         isAuthenticated, planoRoutes);
app.use('/contabilidad',  isAdmin, contabilidadRoutes);
app.use('/proveedores',   isAdmin, proveedoresRoutes);
app.use('/categorias',    isAdmin, categoriasRoutes);
app.use('/cuentas',       isAdmin, cuentasRoutes);
app.use('/api',           isAuthenticated, layoutsRoutes);
app.use('/recuperar',     recuperarRoutes);
app.use(require('./routes/share_stateless'));
app.use('/ausencias',     isAuthenticated, ausenciasRoutes);
app.use('/actividades',   isAuthenticated, actividadesRoutes);
app.use('/espacios',      isAuthenticated, espaciosRoutes);
app.use(pdfRoutes);
app.use('/partituras',    isAuthenticated, partiturasRoutes);
app.use('/plantillas',    isAuthenticated, plantillasRoutes);
app.use('/atril',         atrilRoutes);
app.use('/mensajes',      mensajesRoutes);

// ─── Rutas especiales ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.render('index', { title: 'Inicio - JOSG' });
});

app.get('/obras', (req, res) => {
  res.status(503);
  res.set('Retry-After', '3600');
  res.render('obras', { title: 'Zona de obras' });
});

// VAPID public key para web push
const { VAPID_PUBLIC } = require('./utils/push');
app.get('/push/public-key', (_req, res) => {
  res.json({ key: VAPID_PUBLIC || '' });
});

// ─── 404 ──────────────────────────────────────────────────────────
app.use((req, res) => {
  const esApi = req.originalUrl.startsWith('/api') ||
                req.headers.accept?.includes('application/json');
  if (esApi) return res.status(404).json({ error: 'Ruta no encontrada' });
  res.status(404).send('<h1>404 — Página no encontrada</h1>');
});

// ─── Manejador global de errores 500 ─────────────────────────────
// IMPORTANTE: debe tener exactamente 4 argumentos (err, req, res, next)
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);

  if (res.headersSent) return next(err);

  const esApi = req.originalUrl.startsWith('/api') ||
                req.headers.accept?.includes('application/json');

  if (esApi) {
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  res.status(500).send(`
    <h1>Error del servidor</h1>
    <p>Ha ocurrido un error inesperado. Por favor, inténtalo de nuevo.</p>
    ${process.env.NODE_ENV !== 'production' ? `<pre>${err.stack}</pre>` : ''}
  `);
});

// ─── Arranque ─────────────────────────────────────────────────────
const initDatabase = require('./database/init');
(async () => {
  try {
    await initDatabase();
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Fallo al iniciar la app:', err);
    process.exit(1);
  }
})();
