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
  
    function ensureProto(u){
      if (!u) return '';
      return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u) ? u : 'https://' + u;
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
    
    /* ====================== INDEX (inicio) ====================== */
    async function initIndex(){
      const alumno_id = getAlumnoId();
      const $desco = qs('#desconectado');
      const $con   = qs('#conectado');
  
      if ($desco && $con){
        if (alumno_id){
          $desco.style.display = 'none';
          $con.style.display = 'block';
        } else {
          $desco.style.display = 'block';
          $con.style.display = 'none';
        }
      }
    }
  
    /* ====================== AGENDA (FullCalendar) ====================== */
    async function initAgenda(){
      ensureLogin();
      await loadScript('https://cdn.jsdelivr.net/npm/fullcalendar@6.1.8/index.global.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/fullcalendar@6.1.8/locales-all.global.min.js');
  
      const el = qs('#calendar');
      if (!el) return;
  
      const alumno_id = getAlumnoId();
      const calendar = new window.FullCalendar.Calendar(el, {
        locale: 'es',
        initialView: 'dayGridMonth',
        headerToolbar: {
          left: 'prev,next today',
          center: 'title',
          right: 'dayGridMonth,listMonth'
        },
        buttonText: { today:'Hoy', month:'Mes', list:'Lista' },
        displayEventTime: false,
        events: `/firmas/api/alumno/${alumno_id}/eventos`,
        eventClick(info){
          const id = info.event.id;
          location.href = `evento_alumno.html?id=${id}`;
        }
      });
      calendar.render();
    }
  
    /* ====================== EVENTO (detalle) ====================== */
    async function initEventoAlumno(){
      ensureLogin();
      const alumno_id = getAlumnoId();
      const evento_id = parseInt(getParam('id') || '', 10);
      if (!evento_id){ location.href = 'agenda.html'; return; }
  
      const e = await fetchJSON(`/firmas/api/alumno/${alumno_id}/eventos/${evento_id}`);
  
      function fmtFecha(iso) {
        if (!iso) return '—';
        const [y,m,d] = iso.split('-').map(Number);
        const dt = new Date(Date.UTC(y,(m||1)-1,d||1,12,0,0));
        return dt.toLocaleDateString('es-ES', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone:'Europe/Madrid' });
      }
      function hhmm(s){ return (s || '').toString().slice(0,5) || '—'; }
  
      const rango = `${fmtFecha(e.fecha_inicio)}${e.hora_inicio ? ' · ' + hhmm(e.hora_inicio) : ''}` +
                    (e.fecha_fin ? ` — ${fmtFecha(e.fecha_fin)}${e.hora_fin ? ' · ' + hhmm(e.hora_fin) : ''}` : '');
  
      const $t   = qs('#t');
      const $inf = qs('#info');
      const $desc= qs('#desc');
  
      if ($t)   $t.textContent = e.titulo || 'Evento';
      if ($desc)$desc.textContent = e.descripcion || '';
      if ($inf) $inf.innerHTML = `
        <p><strong>Grupo:</strong> ${e.grupo || '—'}</p>
        <p><strong>Espacio:</strong> ${e.espacio || '—'}</p>
        <p><strong>Cuándo:</strong> ${rango}</p>
        <p class="subtitulo">* Esta vista es informativa: la firma se realiza con el QR del evento.</p>
      `;
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
        $list.innerHTML = list.map(p => `
          <div class="card">
            <h3 style="margin:.2rem 0;">${p.titulo || 'Sin título'}</h3>
            <p class="muted">${[p.autor, p.arreglista].filter(Boolean).join(' · ') || ''}</p>
            <p><strong>Grupo:</strong> ${p.grupo || '—'}</p>
            <p>${p.descripcion ? p.descripcion : ''}</p>
            <p class="links">
              ${p.enlace_partitura ? `<a href="${ensureProto(p.enlace_partitura)}" target="_blank" rel="noopener">Partitura</a>` : ''}
              ${p.enlace_audio ? `<a href="${ensureProto(p.enlace_audio)}" target="_blank" rel="noopener">Audio</a>` : ''}
            </p>
          </div>
        `).join('');
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
    document.addEventListener('DOMContentLoaded', () => {
      // Usa data-page en <body> para decidir qué inicializar
      const page = document.body && document.body.getAttribute('data-page');
  
      if (page === 'index')       return void initIndex();
      if (page === 'agenda')      return void initAgenda();
      if (page === 'evento')      return void initEventoAlumno();
      if (page === 'partituras')  return void initPartituras();
  
      // páginas no listadas: no necesitan init específico
    });
  })();
  