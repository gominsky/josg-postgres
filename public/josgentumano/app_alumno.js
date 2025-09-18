// public/firmas/firmas.js
(function(){
    const qs  = (s) => document.querySelector(s);
    const qsa = (s) => Array.from(document.querySelectorAll(s));
  
    const getAlumnoId = () => localStorage.getItem('alumno_id');
    const ensureLogin = () => { if (!getAlumnoId()) location.href = 'index.html'; };
  
    async function fetchJSON(url, opts){
      const r = await fetch(url, opts);
      let j = null;
      try { j = await r.json(); } catch {}
      if (!r.ok) throw new Error((j && j.error) || r.statusText);
      return j;
    }
  
    function logout(){
      localStorage.removeItem('alumno_id');
      location.href = 'index.html';
    }
    // disponible global para botones inline
    window.logout = logout;
  
    // Reemplaza ensureProto por:
function ensureHref(u){
  if (!u) return '';
  let s = String(u).trim();
  if (!s) return '';

  // URLs absolutas (http, https, mailto, tel, data, blob, etc.)
  if (/^[a-zA-Z][\w.+-]*:/.test(s)) return s;
  // protocol-relative //example.com/...
  if (s.startsWith('//')) return s;
  // rutas del servidor /uploads/..., /files/...
  if (s.startsWith('/')) return s;

  // parece dominio.com/...
  if (/^[\w.-]+\.[a-z]{2,}([/:?#]|$)/i.test(s)) return 'https://' + s;

  // fallback: hacerla root-relative
  return '/' + s.replace(/^\.?\//,'');
}

  
    function getParam(name){
      const v = new URLSearchParams(location.search).get(name);
      return v == null ? null : v;
    }
  
    async function loadScript(src){
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('No se pudo cargar ' + src));
        document.head.appendChild(s);
      });
    }

    async function loadCss(href){
      return new Promise((resolve, reject)=>{
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.onload = resolve;
        l.onerror = () => reject(new Error('No se pudo cargar CSS ' + href));
        document.head.appendChild(l);
      });
}
   
// helpers para index
function monthUpper(d){
  const s = d.toLocaleString('es-ES',{ month:'short' }).replace(/\./g,'');
  return s.toUpperCase(); // ENE, FEB, MAR...
}
function pad2(n){ return String(n).padStart(2,'0'); }

// ====================== INDEX (inicio) ======================
async function initIndex(){
  const alumno_id = getAlumnoId();
  const $desco = qs('#desconectado');
  const $con   = qs('#conectado');
  const $badge = qs('#badge-msg');
  const $upc   = qs('#upcoming');
  const $noev  = qs('#no-events');

  // logout icon
  const btnLogout = qs('#btn-logout');
  if (btnLogout) btnLogout.onclick = logout;

  if (!alumno_id){
    if ($desco) $desco.style.display = 'block';
    if ($con)   $con.style.display   = 'none';
    if (btnLogout) btnLogout.style.display = 'none'; 
    return;
  } else {
    if ($desco) $desco.style.display = 'none';
    if ($con)   $con.style.display   = 'block';
    if (btnLogout) btnLogout.style.display = 'flex'; 
  }

  // 1) Badge de mensajes no leídos (hasta 50 más recientes)
  try{
    const r = await fetch(`/mensajes/app/mensajes?alumno_id=${encodeURIComponent(alumno_id)}`);
    const msgs = await r.json();
    const unread = Array.isArray(msgs) ? msgs.filter(m => !m.leido_at).length : 0;
    if ($badge){
      if (unread > 0) { $badge.textContent = unread; $badge.style.display = 'inline-block'; }
      else { $badge.style.display = 'none'; }
    }
  }catch{ /* silencioso */ }

  // 2) Próximos eventos “cartel”
  try{
    const events = await fetchJSON(`/firmas/api/alumno/${alumno_id}/eventos`);
    const now = new Date();
    // normaliza y filtra a futuro (o hoy con hora futura)
    const futuros = (events || [])
      .map(e => {
        const start = e.start ? new Date(e.start) : null;
        const end   = e.end   ? new Date(e.end)   : null;
        return { ...e, _start:start, _end:end };
      })
      .filter(e => e._start && e._end && e._end >= now)
      .sort((a,b) => a._start - b._start)
      .slice(0, 12); // mostramos hasta 12

    if (!futuros.length){
      if ($upc) $upc.innerHTML = '';
      if ($noev) $noev.style.display = 'block';
      return;
    }
    if ($noev) $noev.style.display = 'none';

    const html = futuros.map(e => {
      const d = e._start;
      const day  = d.getDate();
      const mon  = monthUpper(d);
      const h1   = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      let hora = h1;
      if (e._end) {
        const h2 = pad2(e._end.getHours()) + ':' + pad2(e._end.getMinutes());
        // solo muestra rango si el fin es mismo día y hora distinta
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
  }catch(e){
    console.error('[index] Próximos eventos:', e);
    if ($noev) $noev.textContent = 'No se pudieron cargar los próximos eventos.';
    if ($noev) $noev.style.display = 'block';
  }
}

    async function initAgenda(){
  ensureLogin();

  try {
    // 1) CSS imprescindible
    await loadCss('https://cdn.jsdelivr.net/npm/fullcalendar@6.1.8/main.min.css');

    // 2) JS de FullCalendar
    await loadScript('https://cdn.jsdelivr.net/npm/fullcalendar@6.1.8/index.global.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/fullcalendar@6.1.8/locales-all.global.min.js');

    // 3) Contenedor y altura mínima
    const el = document.querySelector('#calendar');
    if (!el) {
      console.error('[Agenda] No existe #calendar en la página');
      return;
    }
    el.style.minHeight = '60vh';

    // 4) Render
    if (!window.FullCalendar) {
      console.error('[Agenda] FullCalendar no está disponible en window');
      return;
    }

    const alumno_id = getAlumnoId();
    const calendar = new window.FullCalendar.Calendar(el, {
      locale: 'es',
      initialView: 'dayGridMonth',
      headerToolbar: { left:'prev,next today', center:'title', right:'dayGridMonth,listMonth' },
      buttonText: { today:'Hoy', month:'Mes', list:'Lista' },
      displayEventTime: false,
      events: `/firmas/api/alumno/${alumno_id}/eventos`,
      eventClick(info){ location.href = `evento_alumno.html?id=${info.event.id}`; }
    });

    calendar.render();

    // 5) Asegura tamaño tras primer paint (por si el CSS tardó)
    setTimeout(()=> calendar.updateSize(), 50);
    setTimeout(()=> calendar.updateSize(), 300);
  } catch (e) {
    console.error('[Agenda] Error inicializando:', e);
  }
}
    /* ====================== EVENTO (detalle) ====================== */
async function initEventoAlumno(){
  ensureLogin();
  const alumno_id = getAlumnoId();
  const evento_id = parseInt(getParam('id') || '', 10);
  if (!evento_id){ location.href = 'agenda.html'; return; }

  const e = await fetchJSON(`/firmas/api/alumno/${alumno_id}/eventos/${evento_id}`);

  // Helpers
  function parseISO(iso){
    if (!iso) return null;
    const [y,m,d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y,(m||1)-1,d||1,12,0,0)); // mediodía UTC para evitar desfases
  }
  function weekdayName(iso){
    const dt = parseISO(iso);
    if (!dt) return '—';
    const w = dt.toLocaleDateString('es-ES',{ weekday:'long', timeZone:'Europe/Madrid' });
    return w.charAt(0).toUpperCase() + w.slice(1); // Capitaliza
  }
  function fmtDDMMAA(iso){
    if (!iso) return '—';
    const [y,m,d] = iso.split('-').map(Number);
    const dd = String(d).padStart(2,'0');
    const mm = String(m).padStart(2,'0');
    const aa = String(y).slice(-2);
    return `${dd}/${mm}/${aa}`;
  }
  function hhmm(s){ return (s || '').toString().slice(0,5) || '—'; }

  // Construcción del texto de fecha
  const diaIni  = weekdayName(e.fecha_inicio);
  const diaFin  = e.fecha_fin ? weekdayName(e.fecha_fin) : null;
  const fIni    = fmtDDMMAA(e.fecha_inicio);
  const fFin    = e.fecha_fin ? fmtDDMMAA(e.fecha_fin) : null;

  let rango;
  if (e.fecha_fin && e.fecha_fin !== e.fecha_inicio){
    // varios días
    rango = `${diaIni} ${fIni} — ${diaFin} ${fFin}`;
  } else {
    // un día
    if (e.hora_inicio && e.hora_fin) {
      rango = `${diaIni} ${fIni} · ${hhmm(e.hora_inicio)}–${hhmm(e.hora_fin)}`;
    } else if (e.hora_inicio) {
      rango = `${diaIni} ${fIni} · ${hhmm(e.hora_inicio)}`;
    } else {
      rango = `${diaIni} ${fIni}`;
    }
  }

  // Pintado (con filtro de descripción “ruidosa”)
  const $t   = qs('#t');
  const $inf = qs('#info');
  const $desc= qs('#desc');

  if ($t) $t.textContent = e.titulo || 'Evento';

  if ($desc) {
    const desc = String(e.descripcion || '').replace(/\s+/g,' ').trim();
    if (desc.length >= 2 && !/^[DLMXJVS]$/i.test(desc)) {
      $desc.textContent = desc;
      $desc.style.display = 'block';
    } else {
      $desc.style.display = 'none';
    }
  }

  if ($inf) {
    $inf.innerHTML = `
      <p><strong>Grupo:</strong> ${e.grupo || '—'}</p>
      <p><strong>Espacio:</strong> ${e.espacio || '—'}</p>
      <p><strong>Fecha:</strong> ${rango}</p>
    `;
  }
}

    /* ====================== PARTITURAS (por grupos) ====================== */
    async function initPartituras(){
      ensureLogin();
      const alumno_id = getAlumnoId();
      const $list = qs('#list');
      const $q    = qs('#q');
  
      const data = await fetchJSON(`/firmas/api/alumno/${alumno_id}/partituras`);
      window.__PARTS = Array.isArray(data) ? data : [];
  
      function render(list){
  if (!$list) return;
  if (!list || !list.length){
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

  
      function filtrar(){
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
  
    /* ====================== Router por página ====================== */
    function boot(){
      const page = document.body && document.body.getAttribute('data-page');
      if (page === 'index')       return void initIndex();
      if (page === 'agenda')      return void initAgenda();
      if (page === 'evento')      return void initEventoAlumno();
      if (page === 'partituras')  return void initPartituras();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  })();
  