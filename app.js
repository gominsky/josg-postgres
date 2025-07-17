const express = require('express');
const session = require('express-session');
const { isAuthenticated, isAdmin, isDocente } = require('./middleware/auth');
const app = express();
const path = require('path');
const db = require('./database/db');
const expressLayouts = require('express-ejs-layouts');
const methodOverride = require('method-override');

app.use(session({
  secret: 'clave-super-secreta',
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
app.use('/usuarios', usuariosRoutes);

const profesoresRoutes = require('./routes/profesores');
app.use('/profesores', profesoresRoutes);

const alumnosRoutes = require('./routes/alumnos');
app.use('/alumnos', alumnosRoutes);

const gruposRoutes = require('./routes/grupos');
app.use('/grupos', gruposRoutes);

const cuotasRoutes = require('./routes/cuotas');
app.use('/cuotas', cuotasRoutes);

const eventosRoutes = require('./routes/eventos');
app.use('/eventos', eventosRoutes);

const asistenciasRoutes = require('./routes/asistencias');
app.use('/asistencias', asistenciasRoutes);

const informesRoutes = require('./routes/informes');
app.use('/informes', informesRoutes);

const guardiasRoutes = require('./routes/guardias');
app.use('/guardias', guardiasRoutes);

const instrumentosRoutes = require('./routes/instrumentos');
app.use('/instrumentos', instrumentosRoutes);

const tipos_cuotasRoutes = require('./routes/tipos_cuotas');
app.use('/tipos_cuotas', tipos_cuotasRoutes);

const pagosRoutes = require('./routes/pagos');

app.use('/pagos', pagosRoutes);
app.use('/usuarios', isAdmin, usuariosRoutes);        // Solo admin
app.use('/profesores', isAuthenticated, profesoresRoutes); // Admin y docentes
app.use('/alumnos', isDocente, alumnosRoutes);        // Solo docentes
app.use('/grupos', isAuthenticated, gruposRoutes);    // Admin y docentes
app.use('/cuotas', isAdmin, cuotasRoutes);            // Solo admin
app.use('/eventos', isAuthenticated, eventosRoutes);  // Admin y docentes
app.use('/asistencias', isAuthenticated, asistenciasRoutes);
app.use('/informes', isAuthenticated, informesRoutes);
app.use('/guardias', isAuthenticated, guardiasRoutes);
app.use('/instrumentos', isAuthenticated, instrumentosRoutes);
app.use('/tipos_cuotas', isAdmin, tipos_cuotasRoutes); // Solo admin
app.use('/pagos', isAdmin, pagosRoutes);                // Solo admin

app.use(express.static('public'));

// Ruta de inicio
app.get('/', (req, res) => {
  res.render('index', { title: 'Inicio - JOSG' });
});

app.locals.formatDate = (isoDate) => {
  if (!isoDate) return '';
  return new Date(isoDate).toLocaleDateString('es-ES');
};

app.use((req, res, next) => {
  res.locals.mensaje = req.session.mensaje || null;
  delete req.session.mensaje;
  next();
});

// Iniciar servidor
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
