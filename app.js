const express = require('express');
const session = require('express-session');
const { isAuthenticated, isAdmin, isDocente } = require('./middleware/auth');
const app = express();
const path = require('path');
const db = require('./database/db');
const expressLayouts = require('express-ejs-layouts');
const methodOverride = require('method-override');
require('dotenv').config();
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
const firmasRoutes = require('./routes/firmas');
const informesRoutes = require('./routes/informes');
const guardiasRoutes = require('./routes/guardias');
const instrumentosRoutes = require('./routes/instrumentos');
const tipos_cuotasRoutes = require('./routes/tipos_cuotas');
const pagosRoutes = require('./routes/pagos');
const control_firmasRoutes = require('./routes/control_firmas');
const configuracionRoutes = require('./routes/configuracion');
app.use('/configuracion', isAdmin, configuracionRoutes);
app.use('/usuarios', usuariosRoutes);        // Solo admin
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

const initDatabase = require('./database/init'); // Ajusta el path si es necesario

(async () => {
  await initDatabase(); // crea estructura de la base de datos

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
})();

/* Iniciar servidor
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});*/
