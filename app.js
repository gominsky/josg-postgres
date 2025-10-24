//node database/init.js --reset --yes ***resetea BD Completa

const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const app = express();
const path = require('path');
const db = require('./database/db');
const expressLayouts = require('express-ejs-layouts');
const methodOverride = require('method-override');
const fs   = require('fs'); 
require('dotenv').config();
const { isAuthenticated, isAdmin, isDocente } = require('./middleware/auth');
app.set('trust proxy', 1);
app.use('/eventos/styles', express.static(path.join(__dirname, 'public', 'styles')));

// --- Logs de proceso  ---
process.on('beforeExit', (code) => console.log('[proc] beforeExit code=', code));
process.on('exit',       (code) => console.log('[proc] exit code=', code));
process.on('uncaughtException', (err) => {
  console.error('[proc] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[proc] unhandledRejection:', reason);
});

// --- Parsers ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'SESSION_SECRET',
  store: new PgStore({
    db,
    tableName: 'session',           // por defecto es 'session'
    createTableIfMissing: true      // <- crea la tabla si no existe
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
// --- COMPuERTA TEMPRANA PARA API (nunca redirige) ---
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/josgmaestro/api')) {
    // Si trae Authorization (JWT), que lo valide el router:
    if (req.headers.authorization) return next();
    // Si no hay token, exige sesión:
    if (!req.session?.usuario_id) {
      return res.status(401).json({ error: 'auth_required' });
    }
  }
  return next();
});

// --- Guard para páginas estáticas de /josgmaestro (excluye /api) ---
function requireAuthPage(req, res, next) {
  // ¡Nunca interceptar APIs!
  if (req.path.startsWith('/api')) return next();

  // Deja pasar login y assets
  const isAsset = /\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|map)$/.test(req.path);
  const isLogin = req.path === '/' || req.path === '/index.html';
  if (isAsset || isLogin) return next();

  // Si hay sesión, ok; si no, redirige a login
  if (req.session?.usuario_id) return next();
  return res.redirect('/josgmaestro/index.html');
}

// --- Rutas ---
const josgmaestroRouter = require('./routes/josgmaestro');
app.use('/josgmaestro', josgmaestroRouter); // APIs y páginas renderizadas

// --- Estáticos de josgmaestro (protegidos por requireAuthPage) ---
app.use('/josgmaestro', requireAuthPage, express.static(path.join(__dirname, 'public/josgmaestro')));
    
// Middleware para variables de sesión accesibles en views
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  res.locals.error = req.session.error || null;
  delete req.session.error;
  next();
});

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

const authRoutes = require('./routes/auth');
app.use(authRoutes);
app.use(express.static(path.join(__dirname, 'public')));


// Plantillas EJS
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// función global para fechas.
app.locals.formatDate = (isoString) => {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (isNaN(date)) return isoString;
  return date.toLocaleDateString('es-ES'); // formato DD/MM/YYYY
};

// Rutas
const usuariosRoutes = require('./routes/usuarios');
const profesoresRoutes = require('./routes/profesores');
const alumnosRoutes = require('./routes/alumnos');
const gruposRoutes = require('./routes/grupos');
const cuotasRoutes = require('./routes/cuotas');
const eventosRoutes = require('./routes/eventos');
//const firmasRoutes = require('./routes/firmas','routes/josgentumano');
const firmasRoutes = require('./routes/firmas');
const informesRoutes = require('./routes/informes');
const guardiasRoutes = require('./routes/guardias');
const instrumentosRoutes = require('./routes/instrumentos');
const tipos_cuotasRoutes = require('./routes/tipos_cuotas');
const pagosRoutes = require('./routes/pagos');
const configuracionRoutes = require('./routes/configuracion');
const planoRoutes = require('./routes/plano');
const contabilidadRoutes = require('./routes/contabilidad');
const proveedoresRoutes = require('./routes/proveedores');
const categoriasRoutes = require('./routes/categorias');
const cuentasRoutes = require('./routes/cuentas');
const recuperarRoutes = require('./routes/recuperar');
const pdfRoutes = require('./routes/pdf'); 
const layoutsRoutes = require('./routes/layouts');
const ausenciasRoutes = require('./routes/ausencias');
const actividadesRoutes= require('./routes/actividades_complementarias');
const espaciosRoutes = require('./routes/espacios');
const partiturasRoutes = require('./routes/partituras');
const plantillasRoutes = require('./routes/plantillas');
const mensajesRoutes = require('./routes/mensajes');
const atrilRoutes = require('./routes/atril');
const authUnificado = require('./routes/auth_unificado');

app.use('/auth', authUnificado);
app.use('/configuracion', isAdmin, configuracionRoutes);
app.use('/usuarios', isAuthenticated,usuariosRoutes);        
app.use('/profesores', isAuthenticated, profesoresRoutes); 
app.use('/alumnos', isAuthenticated, alumnosRoutes);        
app.use('/grupos', isAdmin, gruposRoutes);  
app.use('/cuotas', isAdmin, cuotasRoutes);            
app.use('/eventos', isAuthenticated, eventosRoutes);  
app.use('/informes', isAuthenticated, informesRoutes);
app.use('/firmas', firmasRoutes); 
app.use('/guardias', isAuthenticated, guardiasRoutes);
app.use('/instrumentos', isAdmin, instrumentosRoutes);
app.use('/tipos_cuotas', isAdmin, tipos_cuotasRoutes); 
app.use('/pagos', isAdmin, pagosRoutes);                
app.use('/plano', isAuthenticated, planoRoutes);
app.use('/contabilidad', isAdmin, contabilidadRoutes);
app.use('/proveedores', isAdmin, proveedoresRoutes);
app.use('/categorias', isAdmin, categoriasRoutes);
app.use('/cuentas', isAdmin, cuentasRoutes);
app.use('/api', isAuthenticated, layoutsRoutes);
app.use('/recuperar',recuperarRoutes);
app.use(require('./routes/share_stateless'));
app.use('/ausencias', isAuthenticated, ausenciasRoutes);
app.use('/actividades', isAuthenticated, actividadesRoutes);
app.use('/espacios', isAuthenticated, espaciosRoutes);
app.use(pdfRoutes);
app.use('/partituras', isAuthenticated, partiturasRoutes);
app.use('/plantillas', isAuthenticated, plantillasRoutes);
app.use('/atril', atrilRoutes);
app.use('/mensajes', mensajesRoutes);

// Ruta de inicio
app.get('/', (req, res) => {
  res.render('index', { title: 'Inicio - JOSG' });
});

app.get('/mensajes/nuevo', isAuthenticated, isDocente, async (req, res) => {
  try {
    const { rows: grupos } = await db.query(
      'SELECT id, nombre FROM grupos ORDER BY nombre'
    );
    const { rows: instrumentos } = await db.query(
      'SELECT id, nombre FROM instrumentos ORDER BY nombre'
    );

    res.render('mensajes_nuevo', {
      title: 'Mensajes',
      grupos,
      instrumentos
    });
  } catch (e) {
    console.error('Error cargando datos mensajes:', e);
    res.render('mensajes_nuevo', {
      title: 'Mensajes',
      grupos: [],
      instrumentos: []   
    });
  }
});

// Página de mantenimiento (zona de obras)
app.get('/obras', (req, res) => {
  res.status(503);                 // 503 = Service Unavailable
  res.set('Retry-After', '3600');  // sugerencia para clientes / SEO (1 hora)
  res.render('obras', { title: 'Zona de obras' });
});

app.use((req, res, next) => {
  res.locals.mensaje = req.session.mensaje || null;
  delete req.session.mensaje;
  next();
});

const initDatabase = require('./database/init'); // Ajustar el path si es necesario

(async () => {
  try {
    await initDatabase();               
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Fallo al iniciar la app:', err);
  }
})();

// en app.js (o donde tengas las rutas)
const { VAPID_PUBLIC } = require('./utils/push');
app.get('/push/public-key', (_req, res) => {
  res.json({ key: VAPID_PUBLIC || '' });
});
