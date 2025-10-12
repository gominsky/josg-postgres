// routes/auth_unificado.js
const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const db      = require('../database/db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

// --- helpers DB ---
async function getUsuarioByEmail(email){
  const { rows } = await db.query(
    `SELECT id, nombre, apellidos, email, rol, password_hash
       FROM usuarios
      WHERE lower(email)=lower($1)
      LIMIT 1`, [email]
  );
  return rows[0] || null;
}

async function getAlumnoByEmail(email){
  // Igual que tu login de alumno: exige registrado=true y compara con bcrypt(password encolumna 'password')
  // :contentReference[oaicite:3]{index=3}
  const { rows } = await db.query(
    `SELECT id, nombre, apellidos, email, registrado, password
       FROM alumnos
      WHERE lower(email)=lower($1) AND registrado = true
      LIMIT 1`, [email]
  );
  return rows[0] || null;
}

// --- POST /auth/login: busca en ambas tablas y decide ---
router.post('/login', express.json(), async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');

  if (!email || !password) return res.status(400).json({ success:false, error:'Faltan credenciales' });

  try {
    const [u, a] = await Promise.all([getUsuarioByEmail(email), getAlumnoByEmail(email)]);
    const candidates = [];

    // Docente/Admin (tabla usuarios, hash en password_hash) :contentReference[oaicite:4]{index=4}
    if (u && u.password_hash && await bcrypt.compare(password, u.password_hash)) {
      // En API maestro usas rol real ('admin'/'docente'); para “puerta” lo tratamos como 'docente' hacia el front
      candidates.push({
        role: (u.rol === 'admin' || u.rol === 'docente') ? 'docente' : 'usuario',
        usuario_id: u.id,
        usuario_nombre: u.nombre,
        nombre: `${u.nombre}${u.apellidos ? ' ' + u.apellidos : ''}`.trim(),
        rol_real: u.rol
      });
    }

    // Alumno (tabla alumnos, password BCRYPT en columna 'password') :contentReference[oaicite:5]{index=5}
    if (a && await bcrypt.compare(password, a.password || '')) {
      candidates.push({
        role: 'alumno',
        alumno_id: a.id,
        alumno_nombre: a.nombre,
        nombre: `${a.nombre}${a.apellidos ? ' ' + a.apellidos : ''}`.trim()
      });
    }

    if (!candidates.length) {
      return res.status(401).json({ success:false, error:'Credenciales incorrectas' });
    }

    const roles = [...new Set(candidates.map(c=>c.role))];

    // Token “general” con lista de roles; aún sin fijar sub (lo fijamos al elegir)
    const token = jwt.sign({ sub: email, roles }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    if (roles.length === 1) {
      const c = candidates[0];
      if (c.role === 'alumno') {
        // Emite JWT compatible con /firmas (sub=alumno_id, rol='alumno') :contentReference[oaicite:6]{index=6}
        const tAlumno = jwt.sign(
          { sub: c.alumno_id, rol: 'alumno', email, nombre: c.alumno_nombre || '' },
          JWT_SECRET, { expiresIn: JWT_EXPIRES }
        );
        return res.json({
          success: true,
          token: tAlumno,
          role: 'alumno',
          usuario: { alumno_id: c.alumno_id, alumno_nombre: c.alumno_nombre },
          redirect: '/index.html' // o la ruta/página de alumno que ya usas
        });
      } else {
        // Emite JWT compatible con API maestro (sub=usuario_id, rol=real) :contentReference[oaicite:7]{index=7}
        const tDoc = jwt.sign(
          { sub: c.usuario_id, rol: c.rol_real },
          JWT_SECRET, { expiresIn: '2h' } // tu /token-login usa 2h; mantenemos ese TTL para docencia
        );
        return res.json({
          success: true,
          token: tDoc,
          role: 'docente',
          usuario: { usuario_id: c.usuario_id, usuario_nombre: c.usuario_nombre },
          redirect: '/portal_maestro.html' // tu portal actual
        });
      }
    }

    // Multirol → que el front muestre modal
    return res.json({
      success: true,
      token,            // contiene {roles:['alumno','docente']}
      roles,
      usuario: { nombre: candidates[0].nombre }
    });

  } catch (err) {
    console.error('[auth_unificado/login]', err);
    res.status(500).json({ success:false, error:'Error interno' });
  }
});

// --- POST /auth/switch-role: fija rol y emite token “scoped” ---
router.post('/switch-role', express.json(), async (req, res) => {
  const { role, email } = req.body || {};
  if (!role || !email) return res.status(400).json({ success:false, error:'Faltan datos' });

  try {
    if (role === 'alumno') {
      const a = await getAlumnoByEmail(email);
      if (!a) return res.status(404).json({ success:false, error:'Alumno no encontrado' });
      const token = jwt.sign({ sub: a.id, rol: 'alumno', email, nombre: a.nombre || '' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      return res.json({
        success:true,
        token,
        usuario: { alumno_id: a.id, alumno_nombre: a.nombre || '' },
        redirect: '/index.html'
      });
    } else if (role === 'docente') {
      const u = await getUsuarioByEmail(email);
      if (!u) return res.status(404).json({ success:false, error:'Usuario no encontrado' });
      const token = jwt.sign({ sub: u.id, rol: u.rol }, JWT_SECRET, { expiresIn: '2h' });
      return res.json({
        success:true,
        token,
        usuario: { usuario_id: u.id, usuario_nombre: u.nombre || '' },
        redirect: '/portal_maestro.html'
      });
    }
    return res.status(400).json({ success:false, error:'Rol no válido' });
  } catch (err) {
    console.error('[auth_unificado/switch-role]', err);
    res.status(500).json({ success:false, error:'Error interno' });
  }
});

module.exports = router;
