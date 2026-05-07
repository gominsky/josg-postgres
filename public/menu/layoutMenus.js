/* /public/js/utils/layoutMenus.js
   Util común para menús con fichas editables.
   Requiere interactjs (CDN) cargado antes.
   Expone: window.LayoutMenus.init(options)
*/
(function (global) {
  // ➕ incluye is-white porque lo usas en Configuración
  const COLORS = ['is-cream','is-yellow','is-blue','is-orange','is-rust','is-black','is-white'];

  function jsonGet(key){ try{ return JSON.parse(localStorage.getItem(key)||'null'); }catch{ return null; } }
  function jsonSet(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch{} }
  function jsonDel(key){ try{ localStorage.removeItem(key); }catch{} }

  function tileColorClass(tile){
    return COLORS.find(c => tile.classList.contains(c)) || null;
  }

  function applyItemStyles(tile, it){
    if(!it) return;
    // Solo tocar color si viene definido en el item
    if (it.color) {
      COLORS.forEach(c=>tile.classList.remove(c));
      tile.classList.add(it.color);
    }
    // Fuerza coordenadas/tamaños si vienen
    if(typeof it.x==='number') tile.style.left  = it.x+'px';
    if(typeof it.y==='number') tile.style.top   = it.y+'px';
    if(typeof it.w==='number') tile.style.width = it.w+'px';
    if(typeof it.h==='number') tile.style.height= it.h+'px';
    if(typeof it.z==='number') tile.style.zIndex= String(it.z);
  }
  

  // === SIEMPRE relativo a grid ===
  function snapshot(wrap, grid, tileSel){
    const rc = grid.getBoundingClientRect(), items = {};
    grid.querySelectorAll(tileSel).forEach(t=>{
      const id=t.dataset.id; if(!id) return;
      const r=t.getBoundingClientRect();
      items[id] = {
        x: Math.max(0, Math.round(r.left - rc.left)),
        y: Math.max(0, Math.round(r.top  - rc.top)),
        w: Math.round(r.width),
        h: Math.round(r.height),
        color: tileColorClass(t),
        z: 0
      };
    });
    return items;
  }

  function collect(wrap, grid, tileSel){
    const items={};
    grid.querySelectorAll(tileSel).forEach(t=>{
      const id=t.dataset.id; if(!id) return;
      const r=t.getBoundingClientRect();
      items[id] = {
        x: parseFloat(t.style.left)||0,
        y: parseFloat(t.style.top)||0,
        w: parseFloat(t.style.width)||r.width,
        h: parseFloat(t.style.height)||r.height,
        color: tileColorClass(t),
        z: parseInt(t.style.zIndex||'0',10)
      };
    });
    return items;
  }

  function buildPayload(grid, items, tileSel){
    const order_ids = Array.from(grid.querySelectorAll(tileSel)).map(a=>a.dataset.id);
    const positions={}, sizes={}, colors={};
    for (const [id, it] of Object.entries(items||{})){
      positions[id] = {
        x: Math.round(it.x||0), y: Math.round(it.y||0),
        w: Math.round(it.w||180), h: Math.round(it.h||120),
        z: it.z||0, color: it.color || null
      };
      if (it.color) colors[id] = it.color; // ← restablecer también colores
      sizes[id] = {
        w: Math.max(1, Math.round((it.w||180)/180)),
        h: Math.max(1, Math.round((it.h||120)/120))
      };
    }
    return { order_ids, sizes, colors, positions };
  }

  async function apiLoad(menuSlug){
    const r = await fetch(`/api/layout/${encodeURIComponent(menuSlug)}`, { credentials:'include' });
    if(!r.ok) throw new Error('load '+r.status);
    return r.json(); // {order_ids,sizes,colors,positions}
  }
  async function apiSave(menuSlug, payload){
    const r = await fetch(`/api/layout/${encodeURIComponent(menuSlug)}`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'include',
      body: JSON.stringify(payload)
    });
    if(!r.ok) throw new Error('save '+r.status);
    return r.json();
  }

  function addTools(tile, persist){
    if (tile.querySelector('.tile-tools')) return;
    const tools = document.createElement('div'); tools.className='tile-tools';
    const bColor=document.createElement('button'); bColor.type='button'; bColor.textContent='Color';
    const bFront=document.createElement('button'); bFront.type='button'; bFront.textContent='⇪ Frente';
    bColor.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation();
      const cur=tileColorClass(tile);
      const idx=cur?COLORS.indexOf(cur):-1;
      const next=COLORS[(idx+1)%COLORS.length];
      COLORS.forEach(c=>tile.classList.remove(c)); tile.classList.add(next);
      persist(tile);
    });
    bFront.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation();
      tile.style.zIndex = String(Date.now()); persist(tile);
    });
    tools.append(bColor,bFront);
    tile.appendChild(tools);
  }

  // límites y sistema de coordenadas coherentes con grid
  function enableInteract(wrap, grid, tileSel, persist, setSuppress){
    const c = grid;
    interact(`${wrap.classList.contains('free') ? '' : '.canvas-wrap.free'} ${'#'+grid.id} ${tileSel}`)
      .draggable({
        listeners:{
          start:e=>e.target.classList.add('dragging'),
          move:e=>{
            const t=e.target;
            const x=(parseFloat(t.style.left)||0)+e.dx;
            const y=(parseFloat(t.style.top)||0)+e.dy;
            const rc=c.getBoundingClientRect(), rt=t.getBoundingClientRect();
            t.style.left=Math.max(0,Math.min(x,rc.width-rt.width))+'px';
            t.style.top =Math.max(0,Math.min(y,rc.height-rt.height))+'px';
          },
          end:e=>{
            e.target.classList.remove('dragging');
            setSuppress();
            persist(e.target);
          }
        }
      })
      .resizable({
        edges:{left:true,right:true,top:true,bottom:true},
        listeners:{
          move:e=>{
            const t=e.target;
            const ox=parseFloat(t.style.left)||0, oy=parseFloat(t.style.top)||0;
            let w=Math.max(180,e.rect.width), h=Math.max(120,e.rect.height);
            t.style.width=w+'px'; t.style.height=h+'px';
            const nx=ox+e.deltaRect.left, ny=oy+e.deltaRect.top;
            const rc=c.getBoundingClientRect();
            t.style.left=Math.max(0,Math.min(nx,rc.width-w))+'px';
            t.style.top =Math.max(0,Math.min(ny,rc.height-h))+'px';
          },
          end:e=>{
            setSuppress();
            persist(e.target);
          }
        }
      });
  }

  function init(options){
    function init(wrap, grid, tileSelector, slug){
      // ⬇️  AQUÍ, al principio de init(), una vez que tengas grid y tileSelector
      grid.querySelectorAll(tileSelector).forEach(t=>{
        // Guardar el color “de fábrica” si no está guardado ya
        if (!t.dataset.defaultColor) {
          const cls = (['is-cream','is-yellow','is-blue','is-orange','is-rust','is-black','is-white'])
            .find(c => t.classList.contains(c)) || '';
          t.dataset.defaultColor = cls;
        }
      });
    
      // ... 🔽 resto de tu init original:
      // cargar estado guardado, preparar drag & drop, listeners, etc.
    }    
    const {
      wrapSelector = '#canvas-wrap',
      gridSelector = '#menu-config',   // o '#menu-principal'
      tileSelector = 'a.tile-sb',
      btnFreeSelector = '#btnLibre',
      btnResetSelector= '#btnReset',
      menuSlug,                        // obligatorio
      lsPrefix = 'layout:',
      saveDebounceMs = 400,
      hotkeySave = true
    } = options || {};

    const wrap = document.querySelector(wrapSelector);
    const grid = document.querySelector(gridSelector);
    const btnFree = document.querySelector(btnFreeSelector);
    const btnReset= document.querySelector(btnResetSelector);
    if(!wrap || !grid || !btnFree) return;

    const slug = menuSlug || wrap.dataset.menu || 'menu';
    const LS_KEY = lsPrefix + slug;

    const loadLocal = ()=> jsonGet(LS_KEY);
    const saveLocal = (o)=> jsonSet(LS_KEY, o);
    const clearLocal= ()=> jsonDel(LS_KEY);
    const def = ()=>({ mode:'grid', items:{} });

    let saveTimer=null;
    function scheduleSave(state){
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async()=>{
        const payload = buildPayload(grid, state.items, tileSelector);
        try{ await apiSave(slug, payload); } catch(e){ saveLocal(state); }
      }, saveDebounceMs);
    }

    // Anti-click + permitir toolbars
    let suppressClickUntil = 0;
    function setSuppress(){ suppressClickUntil = Date.now() + 200; }
    function preventWhileFree(e){
      if (e.target.closest('.tile-tools')) return;
      if (wrap.classList.contains('free') || Date.now() < suppressClickUntil){
        e.preventDefault(); e.stopPropagation(); return false;
      }
    }

    function persistTile(tile){
      const cur = loadLocal() || def();
      if(cur.mode!=='free' && cur.mode!=='free-view') cur.mode='free-view';
      const rc=grid.getBoundingClientRect(), r=tile.getBoundingClientRect();
      cur.items[tile.dataset.id] = {
        x: Math.max(0, Math.round(r.left - rc.left)),
        y: Math.max(0, Math.round(r.top  - rc.top)),
        w: Math.round(r.width),
        h: Math.round(r.height),
        color: tileColorClass(tile),
        z: parseInt(tile.style.zIndex||'0',10)
      };
      saveLocal(cur);
      scheduleSave(cur);
    }

    // snapshot ANTES de activar free-view, y primera vez guarda en BD (incl. colores)
    async function enterView(){
      grid.querySelectorAll(`${tileSelector} .tile-tools`).forEach(t=>t.remove());

      // 1) Intenta cargar del servidor
      let srv = null;
      try { srv = await apiLoad(slug); } catch {}
      const hasSrv = !!(srv && srv.positions && Object.keys(srv.positions).length);
      
      let items;
      if (hasSrv) {
        // Mezcla posiciones del servidor + color del servidor o del DOM si falta
        items = {};
        grid.querySelectorAll(tileSelector).forEach(t => {
          const id = t.dataset.id;
          const pos = srv.positions?.[id] || {};
          const col = (srv.colors && srv.colors[id]) || tileColorClass(t);
          items[id] = { ...pos, color: col };
        });
      } else {
        // Primera vez: snapshot del DOM (incluye colores actuales)
        items = snapshot(wrap, grid, tileSelector);
      }
      

      // 3) Activar vista absoluta y aplicar estilos
      wrap.classList.add('free-view');
      grid.querySelectorAll(tileSelector).forEach(a=>{
        a.style.position='absolute';
        a.style.margin='0';
        applyItemStyles(a, items[a.dataset.id]);
      });

      // 4) Primera vez: persistir en BD (y espejo local)
      if (!hasSrv){
        const cur = loadLocal() || def();
        cur.mode  = 'free-view';
        cur.items = items;
        saveLocal(cur);
        const payload = buildPayload(grid, items, tileSelector);
        try { await apiSave(slug, payload); } catch {}
      }
    }

    // Sustituye exitView() por:
    function exitView(){
      wrap.classList.remove('free','free-view');
      // quitar toolbars si existieran
      grid.querySelectorAll(`${tileSelector} .tile-tools`).forEach(t=>t.remove());
      // IMPORTANT: limpiar estilos inline para volver al flujo natural de grid
      grid.querySelectorAll(tileSelector).forEach(a=>{
        a.style.position = '';
        a.style.margin   = '';
        a.style.left     = '';
        a.style.top      = '';
        a.style.width    = '';
        a.style.height   = '';
        a.style.zIndex   = '';
      });
    }

    function enterFree(){
      if(!wrap.classList.contains('free-view')) {
        // partir de lo que se ve (snapshot en grid y aplicar)
        const items = snapshot(wrap, grid, tileSelector);
        wrap.classList.add('free-view');
        grid.querySelectorAll(tileSelector).forEach(a=>{
          a.style.position='absolute'; a.style.margin='0';
          applyItemStyles(a, items[a.dataset.id]);
        });
      }
      wrap.classList.add('free');
      btnFree.textContent='Guardar';

      grid.querySelectorAll(tileSelector).forEach(a=>a.addEventListener('click', preventWhileFree));
      grid.querySelectorAll(tileSelector).forEach(t=>addTools(t, persistTile));
      enableInteract(wrap, grid, tileSelector, persistTile, setSuppress);
    }

    function exitFree(saveLayout = true){
      if (saveLayout){
        const cur = loadLocal() || def();
        cur.mode  = 'free-view';
        cur.items = collect(wrap, grid, tileSelector);
        saveLocal(cur); scheduleSave(cur);
      }
      wrap.classList.remove('free');
      btnFree.textContent='Modo libre';
      grid.querySelectorAll(tileSelector).forEach(a=>a.removeEventListener('click', preventWhileFree));
      grid.querySelectorAll(`${tileSelector} .tile-tools`).forEach(t=>t.remove());
      if (global.interact) global.interact('.tile-sb').unset?.();
    }

    async function resetAndSaveInitial(){
      // 0) Si esta en modo libre, salimos sin guardar
      if (wrap.classList.contains('free')) exitFree(false);

      // 1) Volver al grid CSS natural (sin estilos inline, sin toolbars)
      exitView();

      // 2) Reaplicar color de fabrica
      grid.querySelectorAll(tileSelector).forEach(a=>{
        const df = a.dataset.defaultColor || null;
        ['is-cream','is-yellow','is-blue','is-orange','is-rust','is-black','is-white']
          .forEach(c => a.classList.remove(c));
        if (df) a.classList.add(df);
      });

      // 3) Borrar layout en servidor (positions vacias = grid CSS al recargar)
      try {
        await apiSave(slug, { order_ids: [], sizes: {}, colors: {}, positions: {} });
      } catch(e) {
        console.warn('[layoutMenus] reset apiSave fallo:', e);
      }

      // 4) Limpiar localStorage y recargar - el grid CSS centra las tiles
      clearLocal();
      location.reload();
    }
    


    // Estado inicial — solo entrar en free-view si hay posiciones guardadas en servidor
    (async()=>{
      try{
        const s = await apiLoad(slug);
        if (s && s.positions && Object.keys(s.positions).length){
          await enterView();
          btnFree.textContent = 'Modo libre';
          return;
        }
      } catch {}
      // Sin layout guardado: dejar el grid CSS intacto, no llamar a enterView
      btnFree.textContent = 'Modo libre';
    })();

    // Hotkey guardar
    if (hotkeySave){
      document.addEventListener('keydown',(e)=>{
        if(!wrap.classList.contains('free')) return;
        const isMac=/Mac/i.test(navigator.platform); const mod=isMac?e.metaKey:e.ctrlKey;
        if(mod && e.key.toLowerCase()==='s'){
          e.preventDefault();
          const cur=loadLocal()||def();
          cur.mode='free-view'; cur.items=collect(wrap, grid, tileSelector);
          saveLocal(cur); scheduleSave(cur);
          btnFree.textContent='Guardado'; setTimeout(()=>btnFree.textContent='Guardar',700);
        }
      });
    }

    // Botones
    btnFree.addEventListener('click', ()=> wrap.classList.contains('free') ? exitFree(true) : enterFree());
    if (btnReset) btnReset.addEventListener('click', async ()=>{
      await resetAndSaveInitial();
      jsonDel(LS_KEY); // limpia espejo local
      btnFree.textContent='Restablecido'; setTimeout(()=>btnFree.textContent='Modo libre',800);
    });

    // API pública opcional
    return { enterView, exitView, enterFree, exitFree, resetAndSaveInitial };
  }

  global.LayoutMenus = { init };
})(window);
