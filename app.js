//node database/init.js --reset --yes ***resetea BD Completa

const express = require('express');
const session = require('express-session');
const { isAuthenticated, isAdmin, isDocente } = require('./middleware/auth');
const app = express();
const path = require('path');
const db = require('./database/db');
const expressLayouts = require('express-ejs-layouts');
const methodOverride = require('method-override');
require('dotenv').config();

process.on('beforeExit', (code) => console.log('[proc] beforeExit code=', code));
process.on('exit',       (code) => console.log('[proc] exit code=', code));
process.on('uncaughtException', (err) => {
  console.error('[proc] uncaughtException:', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[proc] unhandledRejection:', reason);
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

// Middleware para variables de sesión accesibles en views
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  res.locals.error = req.session.error || null;
  delete req.session.error;
  next();
});

// Middleware para procesar formularios y JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const authRoutes = require('./routes/auth');
app.use(authRoutes);

// Method override (para PUT/DELETE en formularios)
app.use(methodOverride('_method'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static('uploads'));
//app.use('/utils', express.static(path.join(__dirname, 'utils')));
// Plantillas EJS
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function requireAlumno(req, res, next) {
  const open = [
    // ✅ home pública
    /^\/josgmaestro\/?$/i,
    /^\/josgmaestro\/index\.html?$/i,

    // ✅ páginas públicas
    /^\/josgmaestro\/login\.html?$/i,
    /^\/josgmaestro\/registro\.html?$/i,

    // ✅ assets
    /^\/josgmaestro\/(styles|imagenes|fonts|favicon\.ico|manifest\.json|.*\.(css|js|png|jpg|svg|webp|ico))$/i
  ];

  if (open.some(rx => rx.test(req.path))) return next();

  if (req.session && (req.session.alumno_id || req.session.usuario_id)) return next();

  if (req.path.startsWith('/josgmaestro/api') || req.path.startsWith('/firmas/api')) {
    return res.status(401).json({ success:false, error:'auth_required' });
  }
  return res.redirect('/josgmaestro/login.html');
}
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
const firmasRoutes = require('./routes/firmas','routes/josgentumano');
const informesRoutes = require('./routes/informes');
const guardiasRoutes = require('./routes/guardias');
const instrumentosRoutes = require('./routes/instrumentos');
const tipos_cuotasRoutes = require('./routes/tipos_cuotas');
const pagosRoutes = require('./routes/pagos');
const control_firmasRoutes = require('./routes/control_firmas');
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
app.use('/configuracion', isAdmin, configuracionRoutes);
app.use('/usuarios', isAuthenticated,usuariosRoutes);        
app.use('/profesores', isAuthenticated, profesoresRoutes); // Admin, docentes y usuarios
app.use('/alumnos', isAuthenticated, alumnosRoutes);        
app.use('/grupos', isAdmin, gruposRoutes);  
app.use('/cuotas', isAdmin, cuotasRoutes);            
app.use('/eventos', isAuthenticated, eventosRoutes);  
app.use('/informes', isAuthenticated, informesRoutes);
app.use('/firmas', firmasRoutes); 
app.use('/guardias', isAuthenticated, guardiasRoutes);
app.use('/instrumentos', isAdmin, instrumentosRoutes);
app.use('/tipos_cuotas', isAdmin, tipos_cuotasRoutes); // Solo admin
app.use('/pagos', isAdmin, pagosRoutes);                // Solo admin
app.use('/control_firmas', control_firmasRoutes);
// Primero el router bajo /josgmaestro para que resuelva /josgmaestro/api/...
app.use('/josgmaestro', control_firmasRoutes);
 // Después los estáticos del portal (carpeta renombrada)
app.use('/josgmaestro', requireAlumno, express.static(path.join(__dirname, 'public_josgmaestro')));

app.use('/plano', isAuthenticated, planoRoutes);
app.use('/contabilidad', isAdmin, contabilidadRoutes);
app.use('/proveedores', isAdmin, proveedoresRoutes);
app.use('/categorias', isAdmin, categoriasRoutes);
app.use('/cuentas', isAdmin, cuentasRoutes);
app.use('/api', isAuthenticated, layoutsRoutes);
app.use('/control_firmas/api', isAuthenticated, layoutsRoutes);

app.use('/recuperar',recuperarRoutes);
app.use(require('./routes/share_stateless'));
app.use('/ausencias', isAuthenticated, ausenciasRoutes);
app.use('/actividades', isAuthenticated, actividadesRoutes);
app.use('/espacios', isAuthenticated, espaciosRoutes);
app.use(pdfRoutes);
app.use('/partituras', isAuthenticated, partiturasRoutes);
app.use('/plantillas', isAuthenticated, plantillasRoutes);
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
      instrumentos: []   // <-- importante para que la vista no pete si hay error
    });
  }
});

// endpoint de salud para comprobar el prefijo desde el front
app.get(['/api/health','/control_firmas/api/health','/josgmaestro/api/health'], (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
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

const initDatabase = require('./database/init'); // Ajusta el path si es necesario

(async () => {
  try {
    await initDatabase();               // <- si falla, lo verás en catch
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

/* Iniciar servidor
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});*/
