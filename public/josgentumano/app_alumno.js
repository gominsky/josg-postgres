// public/firmas/app_alumno.js — lógica común para JOSG en tu mano (alumno)

(function () {
  // ---------- Utils básicos ----------
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const getAlumnoId = () => localStorage.getItem('alumno_id');

  // Páginas públicas (NO requieren sesión)
  const PUBLIC_PAGES = new Set(['index', 'login', 'registro']);

  // Detección de página por data-page (preferente) o por nombre de archivo
  function currentPage() {
    const viaData = (document.body && document.body.getAttribute('data-page')) || '';
    if (viaData) return viaData;
    const file = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    return file.replace('.html', ''); // p.ej. index, agenda, evento, partituras, login, registro
  }

  function needSession() {
    return !PUBLIC_PAGES.has(currentPage());
  }

  function ensureSession() {
      const id = getAlumnoId();
      const token = localStorage.getItem('token');
      if ((!id || !token) && needSession()) {
      location.href = 'login.html';
      return false;
    }
    return true;
  }

  // ---------- Nombre del usuario (topbar) ----------
  function paintUserName() {
    const el = $('#user-name');
    if (!el) return;
    const nombre = localStorage.getItem('alumno_nombre');
    const id = getAlumnoId();
    el.textContent = nombre ? `Hola, ${nombre}` : (id ? `Usuario #${id}` : '');
  }

  async function ensureAlumnoName() {
    const nombre = localStorage.getItem('alumno_nombre');
    const id = getAlumnoId();
    if (nombre || !id) return;
    try {
      const r = await fetch(`/firmas/api/alumno/${id}/basico`, { cache: 'no-store' });
      const j = await r.json();
      if (j && (j.success || j.nombre)) {
        localStorage.setItem('alumno_nombre', j.nombre || '');
        paintUserName();
      }
    } catch { /* silent */ }
  }

  function bindLogout() {
    const btn = $('#btn-logout');
    if (!btn) return;
    btn.addEventListener('click', () => {
      localStorage.removeItem('alumno_id');
      localStorage.removeItem('alumno_nombre');
      localStorage.removeItem('token');
      location.href = 'login.html';
    });
  }

  // ---------- Helpers varios ----------
    async function fetchJSON(url, opts) {
        const token = localStorage.getItem('token');
        const base = opts || {};
        base.headers = Object.assign({}, base.headers, token ? { 'Authorization': 'Bearer ' + token } : {});
        const r = await fetch(url, base);
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error((j && j.error) || r.statusText);
    return j;
  }

  function ensureHref(u) {
    if (!u) return '';
    let s = String(u).trim();
    if (!s) return '';
    if (/^[a-zA-Z][\w.+-]*:/.test(s)) return s;     // http:, https:, mailto:, etc.
    if (s.startsWith('//')) return s;               // //example.com
    if (s.startsWith('/')) return s;                // /files/...
    if (/^[\w.-]+\.[a-z]{2,}([/:?#]|$)/i.test(s)) return 'https://' + s;
    return '/' + s.replace(/^\.?\//, '');
  }

  function getParam(name) {
    const v = new URLSearchParams(location.search).get(name);
    return v == null ? null : v;
  }

  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('No se pudo cargar ' + src));
      document.head.appendChild(s);
    });
  }

  async function loadCss(href) {
    return new Promise((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = resolve;
      l.onerror = () => reject(new Error('No se pudo cargar CSS ' + href));
      document.head.appendChild(l);
    });
  }

  const monthUpper = d => d.toLocaleString('es-ES', { month: 'short' }).replace(/\./g, '').toUpperCase();
  const pad2 = n => String(n).padStart(2, '0');

  // ---------- Páginas ----------
  // INDEX (inicio)
  async function initIndex() {
    const alumno_id = getAlumnoId();
    const $desco = $('#desconectado');
    const $con   = $('#conectado');
    const $badge = $('#badge-msg');
    const $upc   = $('#upcoming');
    const $noev  = $('#no-events');
    const btnLogout = $('#btn-logout');

    // mostrar/ocultar según sesión (index es pública)
    if (!alumno_id) {
      if ($desco) $desco.style.display = 'block';
      if ($con)   $con.style.display   = 'none';
      if (btnLogout) btnLogout.style.display = 'none';
      return;
    } else {
      if ($desco) $desco.style.display = 'none';
      if ($con)   $con.style.display   = 'block';
      if (btnLogout) btnLogout.style.display = 'flex';
    }

    // 1) Badge de mensajes no leídos
    try {
      const r = await fetch(`/mensajes/app/mensajes?alumno_id=${encodeURIComponent(alumno_id)}`);
      const msgs = await r.json();
      const unread = Array.isArray(msgs) ? msgs.filter(m => !m.leido_at).length : 0;
      if ($badge) {
        if (unread > 0) { $badge.textContent = unread; $badge.style.display = 'inline-block'; }
        else { $badge.style.display = 'none'; }
      }
    } catch { /* silent */ }

    // 2) Próximos eventos (cartel)
    try {
      const events = await fetchJSON(`/firmas/api/alumno/${alumno_id}/eventos`);
      const now = new Date();
      const futuros = (events || [])
        .map(e => {
          const start = e.start ? new Date(e.start) : null;
          const end   = e.end   ? new Date(e.end)   : null;
          return { ...e, _start: start, _end: end };
        })
        .filter(e => e._start && e._end && e._end >= now)
        .sort((a, b) => a._start - b._start)
        .slice(0, 12);

      if (!futuros.length) {
        if ($upc) $upc.innerHTML = '';
        if ($noev) $noev.style.display = 'block';
        return;
      }
      if ($noev) $noev.style.display = 'none';

      const html = futuros.map(e => {
        const d = e._start;
        const day = d.getDate();
        const mon = monthUpper(d);
        const h1  = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        let hora  = h1;
        if (e._end) {
          const h2 = pad2(e._end.getHours()) + ':' + pad2(e._end.getMinutes());
          if (d.toDateString() === e._end.toDateString() && h1 !== h2) hora = `${h1}–${h2}`;
        }
        const title = (e.title || 'Evento').trim();
        const espacio = e.extendedProps?.espacio || '';
        return `
          <article class="poster" tabindex="0" role="button" onclick="location.href='evento_alumno.html?id=${e.id}'">
            <div class="date">
              <div class="num">${day}</div>
              <div class="meta"><span>${mon}</span><span>${hora}</span></div>
            </div>
            <div class="line"></div>
            <div class="title">${title}</div>
            ${espacio ? `<div class="muted">${espacio}</div>` : ``}
          </article>
        `;
      }).join('');

      if ($upc) $upc.innerHTML = html;
    } catch (e) {
      console.error('[index] Próximos eventos:', e);
      if ($noev) { $noev.textContent = 'No se pudieron cargar los próximos eventos.'; $noev.style.display = 'block'; }
    }
  }

  // AGENDA
  async function initAgenda() {
    if (!ensureSession()) return;
    try {
      await loadCss('https://cdn.jsdelivr.net/npm/fullcalendar@6.1.8/main.min.css');
      await loadScript('https://cdn.jsdelivr.net/npm/fullcalendar@6.1.8/index.global.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/fullcalendar@6.1.8/locales-all.global.min.js');

      const el = document.querySelector('#calendar');
      if (!el) return console.error('[Agenda] No existe #calendar');

      el.style.minHeight = '60vh';
      if (!window.FullCalendar) return console.error('[Agenda] FullCalendar no está disponible');

      const alumno_id = getAlumnoId();
      const calendar = new window.FullCalendar.Calendar(el, {
        locale: 'es',
        initialView: 'dayGridMonth',
        headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,listMonth' },
        buttonText: { today: 'Hoy', month: 'Mes', list: 'Lista' },
        displayEventTime: false,
        events: `/firmas/api/alumno/${alumno_id}/eventos`,
        eventClick(info) { location.href = `evento_alumno.html?id=${info.event.id}`; }
      });

      calendar.render();
      setTimeout(() => calendar.updateSize(), 50);
      setTimeout(() => calendar.updateSize(), 300);
    } catch (e) {
      console.error('[Agenda] Error inicializando:', e);
    }
  }

  // EVENTO (detalle)
  async function initEventoAlumno() {
    if (!ensureSession()) return;
    const alumno_id = getAlumnoId();
    const evento_id = parseInt(getParam('id') || '', 10);
    if (!evento_id) { location.href = 'agenda.html'; return; }

    const e = await fetchJSON(`/firmas/api/alumno/${alumno_id}/eventos/${evento_id}`);

    const parseISO = iso => { if (!iso) return null; const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0)); };
    const weekdayName = iso => { const dt = parseISO(iso); if (!dt) return '—'; const w = dt.toLocaleDateString('es-ES', { weekday: 'long', timeZone: 'Europe/Madrid' }); return w.charAt(0).toUpperCase() + w.slice(1); };
    const fmtDDMMAA = iso => { if (!iso) return '—'; const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${String(y).slice(-2)}`; };
    const hhmm = s => (s || '').toString().slice(0, 5) || '—';

    const diaIni = weekdayName(e.fecha_inicio);
    const diaFin = e.fecha_fin ? weekdayName(e.fecha_fin) : null;
    const fIni = fmtDDMMAA(e.fecha_inicio);
    const fFin = e.fecha_fin ? fmtDDMMAA(e.fecha_fin) : null;

    let rango;
    if (e.fecha_fin && e.fecha_fin !== e.fecha_inicio) {
      rango = `${diaIni} ${fIni} — ${diaFin} ${fFin}`;
    } else {
      if (e.hora_inicio && e.hora_fin) rango = `${diaIni} ${fIni} · ${hhmm(e.hora_inicio)}–${hhmm(e.hora_fin)}`;
      else if (e.hora_inicio)          rango = `${diaIni} ${fIni} · ${hhmm(e.hora_inicio)}`;
      else                              rango = `${diaIni} ${fIni}`;
    }

    const $t   = $('#t');
    const $inf = $('#info');
    const $desc= $('#desc');

    if ($t)   $t.textContent = e.titulo || 'Evento';
    if ($desc){
      const desc = String(e.descripcion || '').replace(/\s+/g, ' ').trim();
      if (desc.length >= 2 && !/^[DLMXJVS]$/i.test(desc)) { $desc.textContent = desc; $desc.style.display = 'block'; }
      else { $desc.style.display = 'none'; }
    }
    if ($inf) {
      $inf.innerHTML = `
        <p><strong>Grupo:</strong> ${e.grupo || '—'}</p>
        <p><strong>Espacio:</strong> ${e.espacio || '—'}</p>
        <p><strong>Fecha:</strong> ${rango}</p>
      `;
    }
  }

  // PARTITURAS
  async function initPartituras() {
    if (!ensureSession()) return;
    const alumno_id = getAlumnoId();
    const $list = $('#list');
    const $q    = $('#q');

    const data = await fetchJSON(`/firmas/api/alumno/${alumno_id}/partituras`);
    window.__PARTS = Array.isArray(data) ? data : [];

    function render(list) {
      if (!$list) return;
      if (!list || !list.length) {
        $list.innerHTML = '<p class="muted">No hay partituras para tus grupos.</p>';
        return;
      }
      $list.innerHTML = list.map(p => {
        const meta = [p.autor, p.arreglista].filter(Boolean).join(' · ');
        const dur  = (p.duracion || '').toString().trim();
        return `
          <div class="card">
            <h3>${p.titulo || 'Sin título'}</h3>
            ${meta ? `<p class="muted">${meta}</p>` : ''}
            ${p.descripcion ? `<p>${p.descripcion}</p>` : ''}
            ${dur ? `<p class="meta">Duración: ${dur}</p>` : ''}
            <div class="links">
              ${p.enlace_partitura ? `<a href="${ensureHref(p.enlace_partitura)}" target="_blank" rel="noopener">Partitura</a>` : ''}
              ${p.enlace_audio ? `<a href="${ensureHref(p.enlace_audio)}" target="_blank" rel="noopener">Audio</a>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    function filtrar() {
      const q = ($q && $q.value || '').toLowerCase();
      const out = (window.__PARTS || []).filter(p => {
        const txt = `${p.titulo||''} ${p.autor||''} ${p.arreglista||''} ${p.grupo||''}`.toLowerCase();
        return txt.includes(q);
      });
      render(out);
    }
    window.filtrar = filtrar;

    render(window.__PARTS);
  }

  // ---------- Boot por página ----------
  async function boot() {
    // Topbar: nombre + logout (en cualquier página)
    await ensureAlumnoName();
    paintUserName();
    bindLogout();

    // Router por página
    const page = currentPage();
    if (page === 'index')       return void initIndex();
    if (page === 'agenda')      return void initAgenda();
    if (page === 'evento')      return void initEventoAlumno();
    if (page === 'partituras')  return void initPartituras();
    // páginas login/registro no necesitan más
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
