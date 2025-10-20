// utils/cleanupPublicFiles.js
const path = require('path');
const fs = require('fs').promises;

const ROOT = path.resolve(__dirname, '..');             // …/src
const PUBLIC_DIR = path.join(ROOT, 'public');

const ALLOWED = Object.freeze({
  mensajes:   path.join(PUBLIC_DIR, 'mensajes'),
  partituren: path.join(PUBLIC_DIR, 'partituren'),
  partituras: path.join(PUBLIC_DIR, 'partituras'), // compat antigua
});

// Mapea una URL pública o ruta relativa a una ruta ABSOLUTA en disco, si es de las permitidas
function mapPublicToFs(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;

  // Ignora enlaces externos
  if (/^(https?:)?\/\//i.test(s)) return null;

  // Quita prefijos de montaje si vinieran
  s = s.replace(/^\/(josgmaestro|firmas)(?=\/)/, '');

  if (!s.startsWith('/')) s = '/' + s;

  // /mensajes/*
  if (s.startsWith('/mensajes/')) {
    return path.join(ALLOWED.mensajes, s.replace(/^\/mensajes\//, ''));
  }
  // /partituren/* (nuevo)
  if (s.startsWith('/partituren/')) {
    return path.join(ALLOWED.partituren, s.replace(/^\/partituren\//, ''));
  }
  // /partituras/* (compat antiguo)
  if (s.startsWith('/partituras/')) {
    return path.join(ALLOWED.partituras, s.replace(/^\/partituras\//, ''));
  }

  // Cualquier otra cosa: no tocamos
  return null;
}

function isInsideAllowed(absPath) {
  if (!absPath) return false;
  const p = path.resolve(absPath);
  return Object.values(ALLOWED).some(dir => p.startsWith(dir + path.sep));
}

async function unlinkSafe(absPath) {
  if (!absPath) return;
  if (!isInsideAllowed(absPath)) {
    console.warn('[cleanup] Bloqueado (fuera de zona segura):', absPath);
    return;
  }
  try {
    await fs.unlink(absPath);
    console.log('[cleanup] eliminado:', absPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.log('[cleanup] ya no existe:', absPath);
    } else {
      console.warn('[cleanup] error al borrar', absPath, err);
    }
  }
}

async function deletePublicFiles(list) {
  const items = Array.isArray(list) ? list : [list];
  const targets = items
    .filter(Boolean)
    .map(mapPublicToFs)
    .filter(Boolean);

  for (const t of targets) {
    await unlinkSafe(t);
  }
}

module.exports = {
  deletePublicFiles,
  mapPublicToFs,
};
