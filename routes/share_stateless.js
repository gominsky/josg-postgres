// routes/share_stateless.js
// Enlaces públicos SIN base de datos usando tokens firmados (stateless) + redirect.
// Genera: POST /api/share  -> { ok, url, token, expiresAt? }
// Consume: GET  /s/:token.pdf  -> valida token y redirige a tus rutas actuales

const { Router } = require('express');
const crypto = require('crypto');

const router = Router();

/* ====================== Utilidades ====================== */

// Base64URL helpers
function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlJson(obj) { return b64url(Buffer.from(JSON.stringify(obj))); }

// Comparación constante de strings (mismo largo)
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Construye URL absoluta para devolver en el JSON
function fullUrl(req, path) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}${path}`;
}

// Carga de claves con FALLOVER a cero variables de entorno nuevas.
// - Si existe PUBLIC_LINKS_KEYS="v1:clave1,v0:claveAntigua", las usa.
// - Si no, deriva una clave estable de SESSION_SECRET / JWT_SECRET / COOKIE_SECRET.
// - Si ninguna existe, usa una clave efímera en memoria (válida hasta reinicio).
const DEFAULT_KID = 'v1';
function loadKeys() {
  const map = new Map();

  const fromEnv = (process.env.PUBLIC_LINKS_KEYS || '').trim();
  if (fromEnv) {
    fromEnv.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(pair => {
        const [kid, key] = pair.split(':');
        if (kid && key) map.set(kid.trim(), Buffer.from(key.trim(), 'utf8'));
      });
  } else {
    const baseSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET || process.env.COOKIE_SECRET;
    if (baseSecret) {
      const key = crypto.createHash('sha256').update(String(baseSecret)).digest(); // 32 bytes
      map.set(DEFAULT_KID, key);
    } else {
      map.set(DEFAULT_KID + '-ephemeral', crypto.randomBytes(32)); // enlaces caen al reiniciar
    }
  }
  return map;
}
const KEYS = loadKeys();
const ACTIVE_KID = [...KEYS.keys()][0];

// Firma HMAC-SHA256(payloadB64) -> base64url
function hmacSign(kid, payloadB64) {
  const key = KEYS.get(kid);
  return b64url(crypto.createHmac('sha256', key).update(payloadB64).digest());
}

// Verifica token y devuelve payload o null
function verifyAndParse(token) {
  // token = kid.payload.sig
  const [kid, payloadB64, sig] = String(token || '').split('.');
  if (!kid || !payloadB64 || !sig) return null;
  const key = KEYS.get(kid);
  if (!key) return null; // clave rotada o desconocida
  const expected = hmacSign(kid, payloadB64);
  if (!timingSafeEqualStr(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.exp && Date.now() > payload.exp) return null; // caducado
  return payload; // { k, p, i, exp? }
}

// Validaciones mínimas
const ALLOWED = new Set(['informe', 'plano', 'guardias']);
function validate(kind, params) {
  if (!ALLOWED.has(kind)) return 'kind inválido';
  if (!params || typeof params !== 'object') return 'params requerido';

  if (kind === 'informe') {
    if (!/^[0-9]+$/.test(String(params.id || ''))) return 'params.id numérico requerido';
  }

  if (kind === 'plano') {
    const hasTrimestre = params.grupo && params.trimestre;
    const hasLatest = params.grupo && (params.latest === true || params.latest === 'true');
    if (!hasTrimestre && !hasLatest) {
      return 'params.grupo y (params.trimestre o params.latest=true) requeridos';
    }
  }

  if (kind === 'guardias') {
    // Variante por rango de fechas (grupo opcional)
    if (!params.desde || !params.hasta) return 'params.desde y params.hasta requeridos';
  }

  return null;
}

/* ====================== Endpoints ====================== */

// Crea un enlace firmado. Body: { kind, params, expireHours? }
router.post('/api/share', (req, res) => {
  try {
    const { kind, params, expireHours } = req.body || {};
    const err = validate(kind, params);
    if (err) return res.status(400).json({ ok: false, msg: err });

    const now = Date.now();
    const payload = { k: kind, p: params, i: now };
    if (expireHours) payload.exp = now + Number(expireHours) * 3600 * 1000;

    const payloadB64 = b64urlJson(payload);
    const sig = hmacSign(ACTIVE_KID, payloadB64);
    const token = `${ACTIVE_KID}.${payloadB64}.${sig}`;
    const url = fullUrl(req, `/s/${token}.pdf`);

    const resp = { ok: true, token, url };
    if (payload.exp) resp.expiresAt = new Date(payload.exp).toISOString();
    return res.json(resp);
  } catch (e) {
    console.error('POST /api/share error', e);
    return res.status(500).json({ ok: false, msg: 'Error interno' });
  }
});

// Resuelve el token y REDIRIGE a tus rutas actuales (no tocamos plano/guardias)
router.get('/s/:token.pdf', (req, res) => {
  try {
    const payload = verifyAndParse(req.params.token);
    if (!payload) return res.status(404).send('Enlace inválido o caducado');

    const { k: kind, p: params } = payload;

    if (kind === 'informe') {
      const qs = new URLSearchParams();
      if (params.showGroup != null) qs.set('showGroup', String(params.showGroup));
      if (params.showInstrument != null) qs.set('showInstrument', String(params.showInstrument));
      const url = `/pdf/informe/${encodeURIComponent(params.id)}${qs.size ? `?${qs}` : ''}`;
      return res.redirect(302, url);
    }

    if (kind === 'plano') {
      if (params.latest === true || params.latest === 'true') {
        const url = `/plano/latest/${encodeURIComponent(params.grupo)}.pdf`;
        return res.redirect(302, url);
      }
      const url = `/plano/${encodeURIComponent(params.grupo)}/${encodeURIComponent(params.trimestre)}.pdf`;
      return res.redirect(302, url);
    }

    if (kind === 'guardias') {
      // Redirige al alias GET que debe devolver el PDF de la planilla
      if (!params.desde || !params.hasta) {
        return res.status(400).send('Parámetros de guardias insuficientes');
      }
      const qs = new URLSearchParams();
      qs.set('desde', params.desde);
      qs.set('hasta', params.hasta);
      if (params.grupo) qs.set('grupo', params.grupo);
      return res.redirect(302, `/guardias/planilla.pdf?${qs.toString()}`);
    }

    return res.status(400).send('Tipo no soportado');
  } catch (e) {
    console.error('GET /s/:token.pdf error', e);
    return res.status(500).send('Error interno');
  }
});

module.exports = router;
