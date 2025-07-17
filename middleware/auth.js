// middleware/auth.js

function isAuthenticated(req, res, next) {
    if (req.session && req.session.usuario) {
      return next();
    }
    res.redirect('/'); // Puedes redirigir a /login si lo tienes separado
  }
  
  function isAdmin(req, res, next) {
    if (req.session?.usuario?.rol === 'admin') {
      return next();
    }
    res.status(403).render('acceso_denegado');
  }
  
  function isDocente(req, res, next) {
    const rol = req.session?.usuario?.rol;
    if (rol === 'docente' || rol === 'admin') {
      return next();
    }
    res.status(403).render('acceso_denegado');
  }
  
  module.exports = {
    isAuthenticated,
    isAdmin,
    isDocente
  };
  
  