/* =============================================================================
 *  Asientos contables — Lucciano's (frontend)
 *  Vanilla JS, sin build. Habla con el Worker (window.ASIENTOS_API).
 *  Rutas por hash: #/inicio, #/importar, #/enviar, #/asientos, #/asiento/ID,
 *                  #/lotes, #/lote/ID, #/admin, #/cuenta
 *  Misma base visual y de código que la app de facturas de proveedores.
 * ============================================================================= */
'use strict';

// ---------------------------------------------------------------------------
//  Estado y utilidades
// ---------------------------------------------------------------------------
const API = (() => {
  // ?api=http://localhost:8787 permite apuntar a otro Worker (pruebas)
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q) localStorage.setItem('asientos_api', q);
    return (localStorage.getItem('asientos_api') || window.ASIENTOS_API).replace(/\/$/, '');
  } catch { return String(window.ASIENTOS_API).replace(/\/$/, ''); }
})();

// Login único: la sesión viene del portal de Herramientas (Worker acceso-api)
const PORTAL = 'https://herramientas.luccianos.com.ar';
const ACCESO_API = 'https://acceso-api.lucciano-viaticos.workers.dev';
const ACCESO_APP = 'asientos';
// Transición: mientras sea true se puede seguir entrando con la clave vieja de Asientos. Al terminar, pasarlo a false.
const LOGIN_VIEJO = true;
const esTokenViejo = (t) => /^[a-f0-9]{64}$/i.test(t || '');

const S = { token: null, user: null, cfg: { envio_habilitado: false, tope_por_envio: 1 }, empresas: null, vista: null };
try { S.token = localStorage.getItem('asientos_token'); } catch { /* sin storage */ }

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NIVEL = { carga: 1, aprobador: 2, admin: 3 };
const puede = (rol) => S.user && NIVEL[S.user.rol] >= NIVEL[rol];

const fmtNum = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const $$m = (n) => { if (n === null || n === undefined || n === '') return '—'; const x = Number(n); return Number.isFinite(x) ? '$ ' + fmtNum.format(x) : '—'; };
const fmtImp = (n) => (Number(n) ? fmtNum.format(Number(n)) : '');
const fmtF = (v) => {
  if (!v) return '—';
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  return s;
};
const fmtFH = (s) => {
  if (!s) return '—';
  const t = String(s);
  const d = new Date(t.replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/.test(t) || !/\d{2}:\d{2}/.test(t) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? fmtF(t) : d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
};
const fmtCuit = (c) => { c = String(c || ''); return c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : (c || '—'); };
const cent = (n) => Math.round((Number(n) || 0) * 100);
const OBS_MAX = 70;

const ESTADOS = {
  pendiente: 'Listo para enviar', observado: 'Con errores', en_cola: 'En cola', enviando: 'Enviando',
  cargado: 'Cargado en Shares', error: 'Rechazado por Shares', dudoso: 'Dudoso: verificar', descartado: 'Descartado',
};
const badgeEstado = (e) => `<span class="badge b-${esc(e)}">${esc(ESTADOS[e] || e)}</span>`;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'ver' + (error ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, error ? 6000 : 3000);
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  // "Failed to fetch" = no llegó ninguna respuesta (corte de red, el Worker se reinició o se pasó de tiempo).
  // Las consultas (GET) se reintentan solas 2 veces; las que modifican datos no, para no duplicar nada.
  let res;
  for (let intento = 0; ; intento++) {
    try {
      res = await fetch(API + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (method === 'GET' && [502, 503, 504].includes(res.status) && intento < 2) throw new TypeError('HTTP ' + res.status);
      break;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (method !== 'GET' || intento >= 2) throw new Error(method === 'GET' ? 'No hay conexión con el servidor. Probá de nuevo en unos segundos.' : 'Se cortó la conexión y no sé si se guardó. Recargá la pantalla antes de volver a intentar.');
      await new Promise(r => setTimeout(r, 700 * (intento + 1)));
    }
  }
  if (res.status === 401 && S.token && !path.startsWith('/api/login')) {
    salir(false);
    throw new Error('La sesión venció. Volvé a ingresar.');
  }
  if (raw) { if (!res.ok) throw new Error('HTTP ' + res.status); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// Envuelve un botón: lo deshabilita con spinner mientras corre la acción
async function conBoton(btn, fn) {
  const txt = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cargando"></span>'; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = txt; } }
}

function modal(html, { ancho = false, alMontar } = {}) {
  const m = $('#modal');
  $('.modal-box', m).classList.toggle('ancho', ancho);
  $('.modal-cuerpo', m).innerHTML = html;
  m.hidden = false;
  const cerrar = () => { m.hidden = true; $('.modal-cuerpo', m).innerHTML = ''; };
  $('.modal-cerrar', m).onclick = cerrar;
  m.onclick = (e) => { if (e.target === m) cerrar(); };
  if (alMontar) alMontar($('.modal-cuerpo', m), cerrar);
  const primero = $('input, textarea, select', m);
  if (primero) setTimeout(() => primero.focus(), 30);
  return cerrar;
}

// Confirmación propia (en vez de confirm() del navegador, que Chrome puede bloquear en silencio
// si alguna vez se tildó "no permitir más diálogos": ahí el botón parece no hacer nada)
function confirmar(texto, { boton = 'Sí, seguir', peligro = false } = {}) {
  return new Promise((resolve) => {
    let hecho = false;
    modal(`<h2 style="margin-bottom:6px">¿Confirmás?</h2><p class="muted" style="white-space:pre-line;margin:0 0 18px">${esc(texto)}</p>
      <div class="acciones" style="justify-content:flex-end"><button class="btn" data-no>Cancelar</button><button class="btn ${peligro ? 'btn-rojo' : 'btn-acento'}" data-si>${esc(boton)}</button></div>`, {
      alMontar: (el, cerrar) => {
        const fin = (v) => { if (hecho) return; hecho = true; cerrar(); resolve(v); };
        $('[data-si]', el).onclick = () => fin(true);
        $('[data-no]', el).onclick = () => fin(false);
        setTimeout(() => $('[data-si]', el)?.focus(), 0);
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!hecho) { hecho = true; resolve(false); } } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

function pedirTexto({ titulo, ayuda = '', etiqueta = 'Comentario', boton = 'Confirmar', minimo = 5, valor = '' }) {
  return new Promise((resolve) => {
    let listo = false;
    modal(`<h2>${esc(titulo)}</h2>${ayuda ? `<p class="muted">${esc(ayuda)}</p>` : ''}
      <div class="campo"><label>${esc(etiqueta)}</label><textarea id="pt-txt">${esc(valor)}</textarea></div>
      <div class="acciones"><button class="btn btn-negro" id="pt-ok">${esc(boton)}</button><button class="btn" id="pt-no">Cancelar</button></div>`, {
      alMontar: (el, cerrar) => {
        $('#pt-ok', el).onclick = () => {
          const v = $('#pt-txt', el).value.trim();
          if (v.length < minimo) { toast(`Escribí al menos ${minimo} caracteres.`, true); return; }
          listo = true; cerrar(); resolve(v);
        };
        $('#pt-no', el).onclick = () => { cerrar(); resolve(null); };
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!listo) resolve(null); } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

// ---------------------------------------------------------------------------
//  Íconos (trazo de 2px, estilo feather) y avatares
// ---------------------------------------------------------------------------
const svgI = (p) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO = {
  home: svgI('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
  inbox: svgI('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  doc: svgI('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  send: svgI('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  users: svgI('<path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="9" cy="8" r="4"/><path d="M17 11a3 3 0 1 0 0-6M21 21v-2a4 4 0 0 0-3-3.87"/>'),
  gear: svgI('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  search: svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  upload: svgI('<path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  refresh: svgI('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  logout: svgI('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  check: svgI('<path d="M20 6 9 17l-5-5"/>'),
  arrow: svgI('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  back: svgI('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
  user: svgI('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>'),
  copy: svgI('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  shield: svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  calc: svgI('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h8"/>'),
  x: svgI('<path d="M6 6l12 12M18 6 6 18"/>'),
  mail: svgI('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
  sparkle: svgI('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
  sun: svgI('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svgI('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  info: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
  alert: svgI('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  coin: svgI('<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a2.5 2.5 0 0 0-2.5-1.5c-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2a2.6 2.6 0 0 1-2.5-1.5M12 6.5V8M12 16v1.5"/>'),
  ojo: svgI('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  ojoNo: svgI('<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/>'),
  clock: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  calendar: svgI('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'),
  chart: svgI('<path d="M3 3v18h18"/><path d="M7 16v-5M12 16V8M17 16v-8"/>'),
  chat: svgI('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>'),
  phone: svgI('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
  sliders: svgI('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  book: svgI('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
};
const COLORES_AV = ['#b0254a', '#2d5bba', '#1f7a45', '#a85a07', '#6b4bb8', '#0f7d86', '#7a4a2e', '#c0392b'];
const iniciales = (s) => String(s || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(SRL|SAS|S\.?A\.?|SA|SOCIEDAD|ANONIMA)$/i.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase() || String(s || '?').slice(0, 1).toUpperCase();
const colorDe = (s) => COLORES_AV[[...String(s || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORES_AV.length];

// Ojito para ver la contraseña: se agrega solo a cualquier campo de contraseña que aparezca (login, Mi cuenta, modales)
function ojosClave(root = document) {
  $$('input[type="password"]:not([data-ojo])', root).forEach(inp => {
    inp.dataset.ojo = '1';
    const caja = document.createElement('span');
    caja.className = 'clave-caja';
    inp.parentNode.insertBefore(caja, inp);
    caja.appendChild(inp);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'clave-ojo'; b.tabIndex = -1;
    b.setAttribute('aria-label', 'Mostrar contraseña'); b.title = 'Mostrar contraseña';
    b.innerHTML = ICO.ojo;
    b.onclick = () => {
      const ver = inp.type === 'password';
      inp.type = ver ? 'text' : 'password';
      b.innerHTML = ver ? ICO.ojoNo : ICO.ojo;
      const t = ver ? 'Ocultar contraseña' : 'Mostrar contraseña';
      b.setAttribute('aria-label', t); b.title = t;
      inp.focus();
    };
    caja.appendChild(b);
  });
}
new MutationObserver(() => ojosClave()).observe(document.documentElement, { childList: true, subtree: true });

// Tema claro/oscuro (lo inicializa index.html antes de pintar)
function temaActual() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function alternarTema() {
  const nuevo = temaActual() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem('asientos_tema', nuevo); } catch { }
  const b = $('#b-tema'); if (b) b.innerHTML = nuevo === 'dark' ? ICO.sun : ICO.moon;
}


// Color de la barra del navegador en el celu (pistacho en el login, el normal adentro)
function colorBarra(c) {
  $$('meta[name="theme-color"]').forEach(m => { if (!m.dataset.orig) m.dataset.orig = m.content; m.content = c || m.dataset.orig; });
}

// ---- App instalable (celular) ----
const esStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; $$('[data-instalar]').forEach(x => pintarInstalar(x)); });
window.addEventListener('appinstalled', () => { S.instalar = null; toast('Listo: la app quedó en tu pantalla de inicio'); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => null));
}
// Tarjeta "Instalar en el celular" (Mi cuenta, guía y aviso del Director)
function pintarInstalar(el) {
  if (esStandalone()) { el.innerHTML = `<p class="con-ico">${ICO.check}Ya la estás usando como app instalada.</p>`; return; }
  if (S.instalar) {
    el.innerHTML = `<p class="muted">Queda con el logo de Lucciano's en tu pantalla de inicio y abre directo, sin el navegador.</p><button class="btn btn-acento" data-btn-instalar>${ICO.phone}Instalar la app</button>`;
    $('[data-btn-instalar]', el).onclick = async () => { const p = S.instalar; S.instalar = null; p.prompt(); await p.userChoice.catch(() => null); pintarInstalar(el); };
    return;
  }
  el.innerHTML = esIOS()
    ? `<p class="muted">En el iPhone, abrí la app en <b>Safari</b>, tocá el botón <b>Compartir</b> (el cuadrado con la flecha para arriba) y elegí <b>“Agregar a inicio”</b>.</p>`
    : `<p class="muted">Abrí la app en <b>Chrome</b> desde el celular, tocá el menú <b>⋮</b> y elegí <b>“Instalar app”</b> o <b>“Agregar a la pantalla principal”</b>.</p>`;
}
const bloqueInstalar = () => `<div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:8px">Instalar en el celular</h2><div data-instalar></div></div>`;
function montarInstalar(root = document) { $$('[data-instalar]', root).forEach(x => pintarInstalar(x)); }

// ---------------------------------------------------------------------------
//  Calendario propio para los campos de fecha (el del navegador no respeta la letra ni los colores del sistema).
//  En la compu reemplaza al nativo; en el celular se deja el del teléfono, que es más cómodo.
// ---------------------------------------------------------------------------
const CAL_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function cerrarCalendario() { $('#cal-pop')?.remove(); document.removeEventListener('mousedown', calFuera, true); window.removeEventListener('scroll', cerrarCalendario, true); window.removeEventListener('resize', cerrarCalendario); }
function calFuera(e) { if (!e.target.closest('#cal-pop') && !e.target.closest('input[type="date"]')) cerrarCalendario(); }
function abrirCalendario(inp) {
  cerrarCalendario();
  const hoy = new Date().toLocaleDateString('sv-SE');
  const sel = /^\d{4}-\d{2}-\d{2}$/.test(inp.value) ? inp.value : '';
  let ver = new Date((sel || hoy).slice(0, 7) + '-01T12:00:00');
  const pop = document.createElement('div');
  pop.id = 'cal-pop'; pop.className = 'cal-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Elegir fecha');
  document.body.appendChild(pop);
  const fuera = (iso) => (inp.min && iso < inp.min) || (inp.max && iso > inp.max);
  const elegir = (iso) => { inp.value = iso; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); cerrarCalendario(); inp.focus(); };
  const pintar = () => {
    const y = ver.getFullYear(), m = ver.getMonth();
    const ini = new Date(y, m, 1, 12), corr = (ini.getDay() + 6) % 7;   // la semana empieza el lunes
    const dias = [];
    for (let i = 0; i < 42; i++) { const d = new Date(y, m, 1 - corr + i, 12); dias.push(d); }
    pop.innerHTML = `<div class="cal-cab"><button type="button" class="cal-nav" data-n="-1" aria-label="Mes anterior">‹</button><b>${CAL_MESES[m]} ${y}</b><button type="button" class="cal-nav" data-n="1" aria-label="Mes siguiente">›</button></div>
      <div class="cal-sem">${['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-dias">${dias.map(d => { const iso = d.toLocaleDateString('sv-SE'); return `<button type="button" data-d="${iso}" class="${d.getMonth() !== m ? 'otro' : ''} ${iso === hoy ? 'hoy' : ''} ${iso === sel ? 'sel' : ''}" ${fuera(iso) ? 'disabled' : ''}>${d.getDate()}</button>`; }).join('')}</div>
      <div class="cal-pie"><button type="button" class="btn-link" data-hoy ${fuera(hoy) ? 'disabled' : ''}>Hoy</button>${inp.required ? '' : '<button type="button" class="btn-link muted" data-borrar>Borrar</button>'}</div>`;
    $$('.cal-nav', pop).forEach(b => b.onclick = () => { ver = new Date(ver.getFullYear(), ver.getMonth() + Number(b.dataset.n), 1, 12); pintar(); });
    $$('[data-d]', pop).forEach(b => b.onclick = () => elegir(b.dataset.d));
    const bh = $('[data-hoy]', pop); if (bh) bh.onclick = () => elegir(hoy);
    const bb = $('[data-borrar]', pop); if (bb) bb.onclick = () => elegir('');
  };
  pintar();
  const r = inp.getBoundingClientRect(), alto = pop.offsetHeight, ancho = pop.offsetWidth;
  const arriba = r.bottom + alto + 8 > window.innerHeight && r.top - alto - 8 > 0;
  pop.style.top = `${arriba ? r.top - alto - 6 : r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - ancho - 8))}px`;
  setTimeout(() => { document.addEventListener('mousedown', calFuera, true); window.addEventListener('scroll', cerrarCalendario, true); window.addEventListener('resize', cerrarCalendario); }, 0);
}
const CAL_PROPIO = window.matchMedia?.('(pointer: fine)').matches;
document.addEventListener('click', (e) => {
  if (!CAL_PROPIO) return;
  const inp = e.target.closest?.('input[type="date"]');
  if (!inp || inp.disabled || inp.readOnly) return;
  e.preventDefault();
  if ($('#cal-pop')) cerrarCalendario(); else abrirCalendario(inp);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#cal-pop')) { cerrarCalendario(); return; }
  if (CAL_PROPIO && e.target.matches?.('input[type="date"]') && (e.key === 'F4' || (e.altKey && e.key === 'ArrowDown'))) { e.preventDefault(); abrirCalendario(e.target); }
}, true);

// ---------------------------------------------------------------------------
//  Ordenar cualquier tabla tocando el título de la columna (en toda la app).
//  Un toque: de mayor a menor (fechas e importes) o A→Z (texto). Otro toque: al revés.
//  Detecta solo si la columna es fecha, importe/número o texto. Se recuerda por pantalla.
// ---------------------------------------------------------------------------
const ORDEN = {
  // Una sola columna ordenada por tabla (la última que se tocó), recordada por pantalla
  clave: (th) => `orden:${location.hash.split('?')[0]}:${[...th.closest('table').querySelectorAll('thead th')].map(h => h.textContent.trim()).join('|')}`,
  valor(td) {
    if (!td) return { t: 'x', v: '' };
    if (td.dataset.orden != null) { const n = Number(td.dataset.orden); return isNaN(n) ? { t: 's', v: td.dataset.orden } : { t: 'n', v: n }; }
    // En celdas con avatar + nombre (proveedor) se usa el nombre, no las iniciales
    const base = td.querySelector('.prov b, b') || td;
    const txt = (base.innerText || base.textContent || '').trim().split('\n')[0].trim();
    let m = txt.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (m) { const a = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : '0000'; return { t: 'n', v: Number(a + m[2].padStart(2, '0') + m[1].padStart(2, '0')) }; }
    m = txt.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { t: 'n', v: Number(m[1] + m[2] + m[3]) };
    m = txt.replace(/\s/g, '').match(/^(-)?(?:US\$|U\$S|USD|DOL|EUR|\$)?(-)?([\d.]+(?:,\d+)?)(\s*[MK])?/i);
    if (m && /\d/.test(m[3]) && !/^\d{11}$/.test(m[3]) && !/^\d{2}-\d{8}-\d$/.test(txt)) {
      let v = Number(m[3].replace(/\./g, '').replace(',', '.'));
      if (/M/i.test(m[4] || '')) v *= 1e6; else if (/K/i.test(m[4] || '')) v *= 1e3;
      if (m[1] || m[2]) v = -v;
      if (isFinite(v)) return { t: 'n', v };
    }
    return { t: 's', v: txt.toLowerCase() };
  },
  aplicar(th, dir) {
    const tabla = th.closest('table'); const tb = tabla && tabla.tBodies[0]; if (!tb) return;
    const i = [...th.parentElement.children].indexOf(th);
    const filas = [...tb.rows].filter(r => r.cells.length > 1);
    if (filas.length < 2) return;
    const vals = filas.map(r => ({ r, k: ORDEN.valor(r.cells[i]) }));
    const num = vals.filter(x => x.k.t === 'n').length >= vals.filter(x => x.k.t === 's' && x.k.v).length;
    vals.sort((a, b) => {
      let c;
      if (num) c = (a.k.t === 'n' ? a.k.v : -Infinity) - (b.k.t === 'n' ? b.k.v : -Infinity);
      else c = String(a.k.v).localeCompare(String(b.k.v), 'es', { numeric: true });
      return dir === 'asc' ? c : -c;
    });
    vals.forEach(x => tb.appendChild(x.r));
    tabla.querySelectorAll('thead th').forEach(h => h.removeAttribute('data-dir'));
    th.dataset.dir = dir;
  },
  // Primer toque: fechas/importes de mayor a menor; texto de la A a la Z
  primero(th) {
    const tb = th.closest('table')?.tBodies[0]; if (!tb) return 'desc';
    const i = [...th.parentElement.children].indexOf(th);
    const ks = [...tb.rows].slice(0, 15).map(r => ORDEN.valor(r.cells[i]));
    return ks.filter(k => k.t === 'n').length >= ks.filter(k => k.t === 's' && k.v).length ? 'desc' : 'asc';
  },
  // No se ordenan las tablas agrupadas (filas de grupo con colspan): se desarmarían los grupos
  ordenable: (th) => th && th.closest('thead') && !th.querySelector('input,button,select') && th.textContent.trim() && th.closest('table')?.tBodies[0] && !th.closest('table').querySelector('tbody tr.grupo-prov, tbody td[colspan]:not(.vacio)') && !th.closest('table').classList.contains('sin-orden'),
};
document.addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!ORDEN.ordenable(th) || e.target.closest('input,button,select,a')) return;
  const dir = th.dataset.dir ? (th.dataset.dir === 'asc' ? 'desc' : 'asc') : ORDEN.primero(th);
  ORDEN.aplicar(th, dir);
  try { sessionStorage.setItem(ORDEN.clave(th), JSON.stringify({ i: [...th.parentElement.children].indexOf(th), dir })); } catch { }
});
// Las tablas que se dibujan de nuevo vuelven a quedar con el orden elegido
new MutationObserver(() => {
  clearTimeout(ORDEN._t);
  ORDEN._t = setTimeout(() => {
    document.querySelectorAll('table thead th').forEach(th => { if (ORDEN.ordenable(th)) th.classList.add('ordenable'); });
    document.querySelectorAll('table thead tr').forEach(tr => {
      const th0 = tr.querySelector('th.ordenable'); if (!th0) return;
      let g = null; try { g = JSON.parse(sessionStorage.getItem(ORDEN.clave(th0)) || 'null'); } catch { }
      const th = g && tr.children[g.i];
      if (th && ORDEN.ordenable(th) && th.dataset.dir !== g.dir) ORDEN.aplicar(th, g.dir);
    });
  }, 60);
}).observe(document.documentElement, { childList: true, subtree: true });
// Íconos propios de esta app (se suman a los de la base)
Object.assign(ICO, {
  table: svgI('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>'),
  layers: svgI('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  download: svgI('<path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  plus: svgI('<path d="M12 5v14M5 12h14"/>'),
  trash: svgI('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
});

// ---------------------------------------------------------------------------
//  Sesión
// ---------------------------------------------------------------------------
function guardarToken(t) { S.token = t; try { t ? localStorage.setItem('asientos_token', t) : localStorage.removeItem('asientos_token'); } catch { } }
async function salir(llamarApi = true) {
  const central = S.token && !esTokenViejo(S.token);
  if (llamarApi) {
    if (central) await fetch(ACCESO_API + '/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token } }).catch(() => null);
    else await api('/api/logout', { method: 'POST' }).catch(() => null);
  }
  guardarToken(null); S.user = null; S.empresas = null;
  if (central && llamarApi) { location.href = PORTAL; return; }
  location.hash = '';
  vistaLogin();
}

// Llegada desde el portal: #acceso=<código de un solo uso> → se cambia por la sesión de esta app
async function canjearAcceso() {
  // Viene del portal: si ya tiene sesión entra al instante; si no, el portal le consigue una y lo devuelve
  if (location.hash === '#portal') {
    history.replaceState(null, '', location.pathname + location.search + '#/inicio');
    if (!S.token) { location.replace(PORTAL + '/#ir=' + ACCESO_APP); return 'redirigiendo'; }
    return;
  }
  const m = location.hash.match(/^#acceso=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search + '#/inicio');
  try {
    const res = await fetch(ACCESO_API + '/canjear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo: m[1], app: ACCESO_APP }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || 'No se pudo ingresar.');
    guardarToken(r.token);
  } catch (e) {
    setTimeout(() => toast(e.message.includes('fetch') ? 'No se pudo conectar para ingresar. Volvé a entrar desde el portal.' : e.message, true), 400);
  }
}

async function empresas(forzar = false) {
  if (!S.empresas || forzar) S.empresas = (await api('/api/empresas')).empresas;
  return S.empresas;
}
const nombreEmpresa = (cuit) => (S.empresas || []).find(e => e.cuit === cuit)?.razon_social || fmtCuit(cuit);

// ---------------------------------------------------------------------------
//  Excel: lectura y descarga (SheetJS)
// ---------------------------------------------------------------------------
async function leerLibro(file) {
  if (!window.XLSX) throw new Error('No cargó la librería de Excel. Revisá la conexión.');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const hojas = wb.SheetNames.map(n => ({ hoja: n, filas: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '', blankrows: true }) }))
    .filter(h => h.filas.some(f => f.some(c => String(c).trim())));
  if (!hojas.length) throw new Error('El archivo está vacío.');
  return hojas;
}
async function leerFilas(file) { const h = (await leerLibro(file))[0]; return { filas: h.filas, hoja: h.hoja }; }
function descargarXlsx(nombre, hojas) {
  const wb = XLSX.utils.book_new();
  for (const [titulo, filas, anchos] of hojas) {
    const ws = XLSX.utils.aoa_to_sheet(filas);
    if (anchos) ws['!cols'] = anchos.map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, titulo.slice(0, 31));
  }
  XLSX.writeFile(wb, nombre);
}
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
// "1.500.000,50" · "1,500,000.50" · "1.500" (mil) · "1500,5" → texto que entiende parseFloat
function normalizarNumero(s) {
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c > -1 && p > -1) return c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (c > -1) return /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  if (p > -1 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) return s.replace(/\./g, '');
  return s;
}
function montoCelda(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  let s = String(v).trim().replace(/[$\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = normalizarNumero(s);
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round((neg ? -n : n) * 100) / 100 : 0;
}
function fechaCelda(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return { iso: `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { iso: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` };
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (m) return { iso: `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` };
  return { iso: null, raw: s };
}

// Columnas que se reconocen en el Excel (por el título, en cualquier orden y con o sin acentos)
const COLS = [
  ['ref', /^(n[°ºo]?\.?\s*(de\s*)?asiento|asiento|nro\.?( asiento)?|numero( de asiento)?|id|ref(erencia)?)$/],
  ['fecha', /^fecha/],
  ['cuenta', /^(cod(igo|\.)?\s*(de\s*)?(la\s*)?cuenta|cuenta|cta\.?|legajo|codigo|cod\.?|n[°ºo]?\s*cuenta)$/],
  ['debe', /^debe/],
  ['haber', /^haber/],
  ['obs', /(observaci|concepto|leyenda|glosa)/],
];
function detectarColumnas(filas) {
  for (let i = 0; i < Math.min(filas.length, 40); i++) {
    const col = {};
    filas[i].forEach((c, j) => {
      const t = sinAcentos(c);
      if (!t) return;
      for (const [k, rx] of COLS) if (col[k] === undefined && rx.test(t)) { col[k] = j; break; }
    });
    if (col.cuenta !== undefined && (col.debe !== undefined || col.haber !== undefined)) return { fila: i, col };
  }
  return null;
}

// Arma los asientos a partir de las filas. Agrupa por la columna "Asiento" si existe; si no, por fecha,
// por las filas de "Totales" y porque el asiento ya balancea. El texto que va debajo de "Totales" es la observación.
function parsearAsientos(filas) {
  const det = detectarColumnas(filas);
  if (!det) throw new Error('No encontré los títulos de las columnas. El Excel tiene que tener al menos “Cuenta”, “Debe” y “Haber” (descargá el modelo para ver el formato).');
  const { col } = det;
  const txt = (v) => String(v ?? '').trim();
  const out = [], avisos = [];
  let cur = null;
  const balancea = (a) => a.renglones.length >= 2 && a.renglones.reduce((s, r) => s + cent(r.debe) - cent(r.haber), 0) === 0 && a.renglones.some(r => r.debe);
  const cerrar = () => { if (cur && cur.renglones.length) out.push(cur); cur = null; };
  for (let i = det.fila + 1; i < filas.length; i++) {
    const row = filas[i] || [];
    const fila = i + 1;
    if (!row.some(c => txt(c))) { if (cur && col.ref === undefined && balancea(cur)) cerrar(); continue; }
    const cuentaTxt = txt(row[col.cuenta]);
    const codigo = (cuentaTxt.match(/^\d+/) || [''])[0];
    const debe = col.debe !== undefined ? montoCelda(row[col.debe]) : 0;
    const haber = col.haber !== undefined ? montoCelda(row[col.haber]) : 0;
    const textoFila = row.map(txt).join(' ');
    if (!codigo && /\btotal(es)?\b/i.test(sinAcentos(textoFila))) { if (cur) cur.totales = true; continue; }
    if (!codigo && !debe && !haber) {
      // Línea de texto sola: la observación (por ejemplo, la que va debajo de “Totales”)
      const t = (col.obs !== undefined && txt(row[col.obs])) || row.map(txt).filter(x => x && !/^\d+([.,]\d+)?$/.test(x)).join(' ');
      const destino = cur || out[out.length - 1];
      if (destino && !destino.observaciones && t) destino.observaciones = t;
      if (cur && cur.totales) cerrar();
      continue;
    }
    const ref = col.ref !== undefined ? txt(row[col.ref]) : '';
    const f = col.fecha !== undefined ? fechaCelda(row[col.fecha]) : null;
    let nuevo = !cur;
    if (cur) {
      if (cur.totales) nuevo = true;
      else if (col.ref !== undefined) nuevo = !!ref && ref !== cur.ref;
      else if (f?.iso && cur.fecha && f.iso !== cur.fecha) nuevo = true;
      else if (balancea(cur)) nuevo = true;
    }
    if (nuevo) { cerrar(); cur = { ref: ref || `Fila ${fila}`, fila, fecha: null, fecha_raw: null, observaciones: null, renglones: [] }; }
    if (f?.iso && !cur.fecha) cur.fecha = f.iso;
    if (f && !f.iso && f.raw && !cur.fecha_raw) cur.fecha_raw = f.raw;
    const obs = col.obs !== undefined ? txt(row[col.obs]) : '';
    if (obs && !cur.observaciones) cur.observaciones = obs;
    cur.renglones.push({ codigo_cuenta: codigo || cuentaTxt, debe, haber, fila });
  }
  cerrar();
  if (!out.length) throw new Error('No encontré renglones debajo de los títulos.');
  if (col.ref === undefined) avisos.push('El Excel no tiene columna de número de asiento: los separé por fecha, por las filas de “Totales” y por balanceo. Revisá que la cantidad de asientos sea la que esperabas.');
  if (col.fecha === undefined) avisos.push('No encontré la columna “Fecha”.');
  if (col.obs === undefined) avisos.push('No encontré columna de observaciones: tomé como observación el texto que aparece solo en una fila (por ejemplo, debajo de “Totales”).');
  return {
    asientos: out.map(a => ({ ref: a.ref, fila: a.fila, fecha: a.fecha || a.fecha_raw || null, observaciones: a.observaciones, renglones: a.renglones })),
    avisos, columnas: Object.keys(col),
  };
}

// ---------------------------------------------------------------------------
//  Formato "por bloques" (el Excel de movimientos bancarios): en cada hoja, títulos sueltos (BANCO GALICIA,
//  PAGO EXPENSAS…) y después un bloque por asiento:
//      Fecha:  | 15/09/2026 |  |  | ok - pasado
//      Código cuenta | Detalle | Debe | Haber
//      498 | Sellados | 990000 |
//      7   | a Banco Galicia Cta Cte |  | 990000
//          | Totales | 990000 | 990000
//          | Pago imp. Sellos renov alq Recoleta      ← observaciones
//  Columnas fijas: A cuenta, B detalle, C debe, D haber; la fecha va en B y la marca de "pasado" en E.
// ---------------------------------------------------------------------------
const esFilaFecha = (row) => /^fecha\b/.test(sinAcentos(row[0]));
const esFilaTitulos = (row) => /^(cod(igo)?\.?\s*(de\s*)?cuenta|cuenta)$/.test(sinAcentos(row[0]));
function esFormatoBloques(hojas) {
  return hojas.some(h => h.filas.some((f, i) => esFilaFecha(f) && h.filas.slice(i + 1, i + 3).some(esFilaTitulos)));
}
function parsearBloques(hojas) {
  const out = [];
  const info = { vacios: 0, renglones_cero: 0, pasados: 0, hojas: [] };
  const txt = (v) => String(v ?? '').trim();
  for (const { hoja, filas } of hojas) {
    let banco = '', concepto = '', cur = null, n = 0;
    const cerrar = () => {
      if (!cur) return;
      const conImporte = cur.renglones.filter(r => r.debe || r.haber || !r.codigo_cuenta);
      if (!conImporte.length) { info.vacios++; cur = null; return; }   // modelo sin completar
      info.renglones_cero += cur.renglones.length - conImporte.length;
      cur.renglones = conImporte;
      if (cur.pasado) info.pasados++;
      out.push(cur); n++; cur = null;
    };
    filas.forEach((row, i) => {
      const fila = i + 1;
      const [A, B, C, D, E] = [row[0], row[1], row[2], row[3], row[4]];
      const tA = txt(A), tB = txt(B), tE = txt(E);
      if (esFilaFecha(row)) {
        cerrar();
        const f = fechaCelda(B);
        cur = { ref: `${hoja.slice(0, 40)} f${fila}`, fila, hoja, fecha: f?.iso || null, fecha_raw: f && !f.iso ? f.raw : null,
          observaciones: null, renglones: [], totales: false, pasado: /pasad/i.test(tE), marca: tE || null,
          origen: [hoja, banco, concepto].filter(Boolean).join(' · ') };
        return;
      }
      if (esFilaTitulos(row)) return;
      const debe = montoCelda(C), haber = montoCelda(D);
      const codigo = (tA.match(/^\d+$/) || [''])[0];
      if (!cur) {   // fuera de un bloque: títulos de banco y de concepto
        if (tA && !tB && !debe && !haber) { if (/^banco\b/i.test(tA)) { banco = tA; concepto = ''; } else concepto = tA; }
        return;
      }
      if (/pasad/i.test(tE)) { cur.pasado = true; cur.marca = cur.marca || tE; }
      if (!tA && /^totales?$/i.test(tB)) { cur.totales = true; return; }
      if (codigo || debe || haber) {
        if (cur.totales) { cerrar(); return; }   // renglón suelto después de los totales: no debería pasar
        cur.renglones.push({ codigo_cuenta: codigo || tA, detalle: tB.replace(/\s+/g, ' '), debe, haber, fila });
        return;
      }
      if (!tA && tB) { if (!cur.observaciones) cur.observaciones = tB.replace(/\s+/g, ' '); return; }
      if (tA && !tB) {   // un título nuevo cierra el bloque anterior
        cerrar();
        if (/^banco\b/i.test(tA)) { banco = tA; concepto = ''; } else concepto = tA;
      }
    });
    cerrar();
    info.hojas.push({ hoja, asientos: n });
  }
  if (!out.length) throw new Error('No encontré asientos con importes en el archivo.');
  const avisos = [];
  if (info.vacios) avisos.push(`Ignoré ${info.vacios} bloque${info.vacios > 1 ? 's' : ''} sin importes (modelos sin completar, por ejemplo con la fecha vacía y todo en cero).`);
  if (info.renglones_cero) avisos.push(`Saqué ${info.renglones_cero} ${info.renglones_cero > 1 ? 'renglones' : 'renglón'} con importe cero dentro de asientos que sí tienen importes (por ejemplo, un sindicato que este mes no se pagó).`);
  return { formato: 'bloques', asientos: out.map(a => ({ ...a, fecha: a.fecha || a.fecha_raw || null })), avisos, info };
}
function parsearArchivo(hojas) {
  if (esFormatoBloques(hojas)) return parsearBloques(hojas);
  const p = parsearAsientos(hojas[0].filas);
  return { ...p, formato: 'tabla', info: { pasados: 0, hojas: [{ hoja: hojas[0].hoja, asientos: p.asientos.length }] } };
}

function descargarModelo() {
  // Mismo formato que el Excel de movimientos bancarios: un bloque por asiento
  const bloque = (fecha, renglones, obs) => [
    ['Fecha:', fecha], ['Código cuenta', 'Detalle', 'Debe', 'Haber'],
    ...renglones, ['', 'Totales', renglones.reduce((x, r) => x + (Number(r[2]) || 0), 0), renglones.reduce((x, r) => x + (Number(r[3]) || 0), 0)], ['', obs], [],
  ];
  descargarXlsx('modelo-asientos.xlsx', [['Egresos bancarios', [
    ['BANCO GALICIA'], [], ['PAGO GASTOS'],
    ...bloque('15/09/2026', [[498, 'Sellados', 990000, ''], [430, 'Intereses negativos', 295530.84, ''], [7, 'a Banco Galicia Cta Cte', '', 1285530.84]], 'Pago imp. Sellos renov alq Recoleta'),
    ['TRANSF. ENTRE CUENTAS'],
    ...bloque('04/09/2026', [[7, 'Banco Galicia Cta Cte', 110000000, ''], [6, 'Banco provincia cta cte', '', 110000000]], 'Transferencia entre cuentas'),
  ], [14, 34, 16, 16, 14]], ['Cómo completarlo', [
    ['Un bloque por asiento: la fila “Fecha:” (con la fecha al lado), los títulos, los renglones, “Totales” y abajo la observación.'],
    ['Columnas fijas: A código de cuenta (legajo de Shares, hasta 3 dígitos) · B detalle · C debe · D haber. La marca “ok - pasado” va en la columna E.'],
    ['Los títulos sueltos (BANCO GALICIA, PAGO GASTOS…) son opcionales: la app los usa para mostrar de dónde sale cada asiento.'],
    ['Los bloques con todo en cero o sin fecha se ignoran (sirven de modelo para el mes siguiente).'],
    ['Puede haber varias hojas: la app lee todas. La empresa y el año contable se eligen en la app al subir el archivo.'],
  ], [120]]]);
}

// ---------------------------------------------------------------------------
//  Login
// ---------------------------------------------------------------------------
function colorBarra(c) {
  $$('meta[name="theme-color"]').forEach(m => { if (!m.dataset.orig) m.dataset.orig = m.content; m.content = c || m.dataset.orig; });
}

async function vistaLogin() {
  let setup = false;
  try { setup = (await api('/api/estado')).setup_requerido; } catch (e) {
    $('#app').innerHTML = `<div class="login"><div class="login-arte"><img src="logo-negro.png" alt="Lucciano's"><div></div></div>
      <div class="login-form"><div class="caja"><h1>Sin conexión</h1><p>No pude conectar con el servidor (${esc(API)}).<br>${esc(e.message)}</p><button class="btn btn-acento btn-grande" onclick="location.reload()">${ICO.refresh}Reintentar</button></div></div></div>`;
    return;
  }
  $('#app').innerHTML = `<div class="login">
    <div class="login-arte"><img src="logo-negro.png" alt="Lucciano's"><p class="login-sub">Asientos contables</p>
      <div class="login-txt"><h2>Carga de asientos contables en Shares.</h2><p>Subís el Excel, la app controla cada asiento y lo registra en Shares de a uno, con el número que devuelve el ERP y sin duplicados.</p></div>
      <div class="pasos"><span>${ICO.upload}Subís el Excel</span><span>${ICO.shield}Se controla</span><span>${ICO.check}Lo aprobás</span><span>${ICO.send}Va a Shares</span></div></div>
    <div class="login-form"><form id="f-login">
      <h1>${setup ? 'Primer ingreso' : 'Ingresar'}</h1>
      <p>${setup ? 'Creá el usuario administrador.' : "Entrá desde el portal de Herramientas, con tu usuario de Lucciano's."}</p>
      ${setup ? '' : `<a class="btn btn-acento btn-grande" href="${PORTAL}/#ir=${ACCESO_APP}" style="text-decoration:none;justify-content:center">Ir al portal ${ICO.arrow}</a>`}
      ${setup ? '' : (LOGIN_VIEJO ? '<details class="login-viejo" style="margin-top:22px"><summary style="cursor:pointer;color:var(--muted,#777);font-size:13.5px">Ingresar con la clave anterior de Asientos</summary><div style="margin-top:14px">' : '<div hidden>')}
      ${setup ? '<div class="campo"><label for="lg-n">Nombre</label><input id="lg-n" name="nombre" required autocomplete="name"></div>' : ''}
      <div class="campo"><label for="lg-u">Mail</label><input id="lg-u" name="email" type="email" required autocomplete="username"></div>
      <div class="campo"><label for="lg-p">Contraseña</label><input id="lg-p" name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 10 : 1}"></div>
      <div class="campo hidden" id="c-totp"><label for="lg-t">Código de verificación</label><input id="lg-t" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" class="mono"></div>
      <button class="btn btn-acento btn-grande" type="submit">${setup ? 'Crear y entrar' : 'Entrar'} ${ICO.arrow}</button>
      ${setup ? '' : (LOGIN_VIEJO ? '</div></details>' : '</div>')}
    </form></div></div>`;
  colorBarra('#B39DDB');
  $('#f-login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    await conBoton($('button[type=submit]', e.target), async () => {
      const r = await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body: fd });
      if (r.requiere_totp) { $('#c-totp').classList.remove('hidden'); $('#c-totp input').focus(); toast('Ingresá el código de tu app autenticadora.'); return; }
      colorBarra(null); guardarToken(r.token); S.user = r.usuario;
      if (!location.hash) location.hash = '#/inicio';
      iniciar();
    });
  };
}

// ---------------------------------------------------------------------------
//  Shell (barra lateral + barra superior + menú inferior en celular) y router
// ---------------------------------------------------------------------------
const RUTAS = [
  { re: /^#\/inicio$/, v: vistaInicio, nav: 'inicio', miga: '<b>Inicio</b>' },
  { re: /^#\/importar$/, v: vistaImportar, nav: 'importar', miga: 'Trabajo / <b>Importar Excel</b>' },
  { re: /^#\/enviar$/, v: vistaEnviar, nav: 'enviar', miga: 'Trabajo / <b>Enviar a Shares</b>' },
  { re: /^#\/asientos$/, v: vistaAsientos, nav: 'asientos', miga: 'Trabajo / <b>Asientos</b>' },
  { re: /^#\/asiento\/(\d+)$/, v: vistaAsiento, nav: 'asientos', miga: 'Trabajo / Asientos / <b>Asiento</b>' },
  { re: /^#\/lotes$/, v: vistaLotes, nav: 'lotes', miga: 'Trabajo / <b>Archivos subidos</b>' },
  { re: /^#\/lote\/(\d+)$/, v: vistaLote, nav: 'lotes', miga: 'Trabajo / Archivos subidos / <b>Archivo</b>' },
  { re: /^#\/admin$/, v: vistaAdmin, nav: 'admin', miga: 'Datos / <b>Configuración</b>' },
  { re: /^#\/guia$/, v: vistaGuia, nav: 'guia', miga: '<b>Guía de uso</b>' },
  { re: /^#\/cuenta$/, v: vistaMiCuenta, nav: '', miga: '<b>Mi cuenta</b>' },
];

function estadoEnvioTxt() {
  if (!S.cfg.envio_habilitado) return ['Envío a Shares apagado', false];
  if (S.cfg.tope_por_envio) return [`Shares: de a ${S.cfg.tope_por_envio} (prueba)`, false];
  return ['Envío a Shares activo', true];
}

function shell(ruta) {
  const a = ruta.nav;
  const it = (k, ic, t, cnt = '') => `<a href="#/${k}" class="${k === a ? 'activo' : ''}" ${k === a ? 'aria-current="page"' : ''}>${ICO[ic]}<span>${t}</span>${cnt}</a>`;
  const rol = { admin: 'Administrador', aprobador: 'Aprobador', carga: 'Carga' }[S.user.rol] || S.user.rol;
  const [txtEnvio, okEnvio] = estadoEnvioTxt();
  return `<div class="app">
    <aside class="side">
      <a class="brand" href="#/inicio"><img src="logo-negro.png" alt="Lucciano's"><span>Asientos contables</span></a>
      <nav class="nav" aria-label="Secciones">
        ${it('inicio', 'home', 'Inicio')}
        <div class="grp-t">Trabajo</div>
        ${it('importar', 'upload', 'Importar Excel')}
        ${it('enviar', 'send', 'Enviar a Shares', '<span class="cnt hot" data-cnt="enviar"></span>')}
        ${it('asientos', 'table', 'Asientos', '<span class="cnt hot" data-cnt="dudosos"></span>')}
        ${it('lotes', 'layers', 'Archivos subidos')}
        ${puede('admin') ? `<div class="grp-t">Datos</div>${it('admin', 'gear', 'Configuración')}` : ''}
        <div class="grp-t">Ayuda</div>
        ${it('guia', 'book', 'Guía de uso')}
      </nav>
      <div class="me"><a class="av" href="#/cuenta" title="Mi cuenta">${esc(iniciales(S.user.nombre))}</a>
        <a class="who" href="#/cuenta"><b>${esc(S.user.nombre)}</b><small>${esc(rol)}</small></a>
        <div class="ibtns"><button class="ibtn" id="b-tema" title="Claro / oscuro" aria-label="Cambiar tema">${temaActual() === 'dark' ? ICO.sun : ICO.moon}</button><a class="ibtn" href="${PORTAL}" title="Volver al portal" aria-label="Volver al portal">${svgI('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>')}</a></div></div>
    </aside>
    <div style="min-width:0">
      <header class="top"><img class="marca-m" src="logo-negro.png" alt="Lucciano's"><div class="crumbs">${ruta.miga}</div>
        <label class="buscar">${ICO.search}<input id="buscar-global" placeholder="Buscar asiento o cuenta…" title="Buscá por asiento, observación, cuenta o N° de Shares" aria-label="Buscar"><kbd>Ctrl K</kbd></label>
        <div class="estado-sis" title="Envío a Shares"><i style="${okEnvio ? '' : 'background:var(--warn);box-shadow:0 0 0 3px var(--warn-bg)'}"></i>${esc(txtEnvio)}</div><button class="ibtn" id="b-actualizar" title="Actualizar" aria-label="Actualizar">${ICO.refresh}</button></header>
      <main id="vista" class="entra"><div class="vacio"><span class="cargando"></span></div></main>
    </div></div>
    <nav class="mnav" aria-label="Secciones">
      <a href="#/inicio" class="${a === 'inicio' ? 'activo' : ''}">${ICO.home}Inicio</a>
      <a href="#/importar" class="${a === 'importar' ? 'activo' : ''}">${ICO.upload}Importar</a>
      <a href="#/enviar" class="${a === 'enviar' ? 'activo' : ''}">${ICO.send}Enviar<span class="cnt hot" data-cnt="enviar"></span></a>
      <a href="#/asientos" class="${a === 'asientos' ? 'activo' : ''}">${ICO.table}Asientos<span class="cnt hot" data-cnt="dudosos"></span></a>
      <a href="#/lotes" class="${a === 'lotes' ? 'activo' : ''}">${ICO.layers}Archivos</a>
    </nav>`;
}

// Contadores del menú (se guardan 60 s)
async function contadores(t = null) {
  try {
    if (!t) {
      if (S.cnt && Date.now() - S.cnt.at < 60000) return pintarContadores(S.cnt);
      t = await api('/api/tablero');
    }
    const pe = t.por_estado || {};
    S.cnt = { at: Date.now(), enviar: (pe.pendiente?.n || 0) + (pe.error?.n || 0), dudosos: pe.dudoso?.n || 0 };
    pintarContadores(S.cnt);
  } catch { /* no es crítico */ }
}
function pintarContadores(c) { $$('[data-cnt]').forEach(x => { const n = c[x.dataset.cnt]; x.textContent = n ? n : ''; }); }

async function router() {
  if (!S.token) return vistaLogin();
  const h = location.hash || '#/inicio';
  const r = RUTAS.find(x => x.re.test(h)) || RUTAS[0];
  const m = h.match(r.re) || [];
  $('#app').innerHTML = shell(r);
  $('#b-actualizar').onclick = actualizar;
  $('#b-tema').onclick = alternarTema;
  const bg = $('#buscar-global');
  bg.onkeydown = (e) => {
    if (e.key !== 'Enter' || !bg.value.trim()) return;
    sessionStorage.setItem('asientos_q', bg.value.trim());
    if (location.hash === '#/asientos') router(); else location.hash = '#/asientos';
  };
  S.vista = h;
  window.scrollTo(0, 0);
  if (r.nav !== 'inicio') contadores();
  try { await r.v($('#vista'), ...m.slice(1)); }
  catch (e) { if (S.token && $('#vista')) { $('#vista').innerHTML = `<div class="panel panel-pad"><h2>No se pudo cargar</h2><p class="muted">${esc(e.message)}</p><button class="btn btn-acento" id="b-reint">${ICO.refresh}Reintentar</button></div>`; $('#b-reint').onclick = router; } }
}

async function actualizar() {
  const b = $('#b-actualizar');
  if (b) b.classList.add('girando');
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) { await reg.update().catch(() => null); if (reg.waiting || reg.installing) { location.reload(); return; } }
    S.cnt = null; S.empresas = null;
    await cargarYo();
    await router();
    toast('Actualizado');
  } finally { const x = $('#b-actualizar'); if (x) x.classList.remove('girando'); }
}

async function cargarYo() {
  const r = await api('/api/yo');
  S.user = r.usuario;
  S.cfg = { envio_habilitado: !!r.envio_habilitado, tope_por_envio: Number(r.tope_por_envio) || 0 };
}

async function iniciar() {
  if (await canjearAcceso() === 'redirigiendo') return;
  if (!S.token) return vistaLogin();
  try { await cargarYo(); } catch { return vistaLogin(); }
  empresas().catch(() => null);
  await router();
  bienvenida();
}
window.addEventListener('hashchange', router);
document.addEventListener('DOMContentLoaded', iniciar);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { const b = $('#buscar-global'); if (b) { e.preventDefault(); b.focus(); b.select(); } }
});

// ---------------------------------------------------------------------------
//  Piezas comunes de las vistas
// ---------------------------------------------------------------------------
const kpi = (et, val, sub = '', { href = '', clase = '' } = {}) => href
  ? `<a class="kpi ${clase}" href="${href}"><div class="et">${et}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</a>`
  : `<div class="kpi ${clase}"><div class="et">${et}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

function chipsProblemas(a) {
  const p = a.problemas || {};
  const out = [];
  if ((p.errores || []).length) out.push(`<span class="badge b-error" title="${esc(p.errores.join('\n'))}">${p.errores.length} error${p.errores.length > 1 ? 'es' : ''}</span>`);
  if (a.duplicado_de && !a.dup_aceptado && !['cargado', 'descartado'].includes(a.estado)) out.push(`<span class="badge b-dudoso" title="Igual al asiento #${a.duplicado_de}">Igual a #${a.duplicado_de}</span>`);
  if (a.dup_aceptado) out.push('<span class="badge b-aviso">Duplicado aceptado</span>');
  if (a.mensaje && ['error', 'dudoso', 'observado', 'en_cola'].includes(a.estado)) out.push(`<small class="sub-celda" title="${esc(a.mensaje)}" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(a.mensaje)}</small>`);
  return out.join(' ');
}

function filaAsiento(a, { check = false, empresa = true } = {}) {
  return `<tr class="click" data-id="${a.id}">
    ${check ? `<td><input type="checkbox" data-sel="${a.id}" data-total="${a.total || 0}" data-dup="${a.duplicado_de && !a.dup_aceptado ? 1 : 0}" aria-label="Elegir asiento ${esc(a.ref)}"></td>` : ''}
    <td class="mono" data-orden="${a.id}"><b>${esc(a.ref)}</b><small class="sub-celda" title="${esc(a.origen || '')}" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">#${a.id}${a.origen ? ' · ' + esc(a.origen.split(' · ').slice(1).join(' · ') || a.origen) : (a.fila ? ` · fila ${a.fila}` : '')}</small></td>
    ${empresa ? `<td>${esc(a.empresa || fmtCuit(a.cuit_empresa))}</td>` : ''}
    <td class="mono">${fmtF(a.fecha)}</td>
    <td style="max-width:320px"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.observaciones || '—')}</span><small class="sub-celda">${a.renglones || 0} renglones</small></td>
    <td class="num">${$$m(a.total)}</td>
    <td>${badgeEstado(a.estado)}<div class="chips" style="margin-top:4px">${chipsProblemas(a)}</div></td>
    <td class="mono num">${a.shares_numero ? 'N° ' + esc(a.shares_numero) : '—'}</td></tr>`;
}
const encabezadoAsientos = ({ check = false, empresa = true } = {}) => `<tr>${check ? '<th><input type="checkbox" id="todas" aria-label="Elegir todos"></th>' : ''}<th>Asiento</th>${empresa ? '<th>Empresa</th>' : ''}<th>Fecha</th><th>Observaciones</th><th class="num">Total</th><th>Estado</th><th class="num">Shares</th></tr>`;
function conectarFilas(el) {
  $$('tr.click[data-id] td', el).forEach(td => { if (td.querySelector('input')) return; td.onclick = () => { location.hash = '#/asiento/' + td.parentElement.dataset.id; }; });
}

// Panel de la cola: cuántos faltan, si hay dudosos, pausa de Shares y los últimos resultados.
// Mientras la pantalla está abierta, cada 15 s le da un empujón (además del cron cada 5 min).
async function montarPanelCola(el, alTerminar) {
  const caja = $('#cola', el); if (!caja) return;
  let antes = null;
  const pintar = (c) => {
    const activas = (c.en_cola || 0) + (c.enviando || 0);
    const rec = c.recientes || [];
    const ok = rec.filter(x => x.estado === 'cargado').length, mal = rec.filter(x => x.estado !== 'cargado');
    if (!activas && !rec.length && !c.dudosos) { caja.innerHTML = ''; return activas; }
    const dudTxt = c.dudosos ? ` · <b>${c.dudosos} dudoso${c.dudosos > 1 ? 's' : ''} para verificar en Shares</b> (<a href="#/asientos" data-ir-dudosos>ver</a>)` : '';
    caja.innerHTML = `<div class="panel panel-pad cola ${activas ? 'activa' : ''}">
      <div class="cola-top">${activas && !c.pausa_hasta ? '<span class="cargando"></span>' : (c.pausa_hasta || c.dudosos ? ICO.alert : ICO.check)}
        <div><b>${c.pausa_hasta && activas ? `Envío en pausa: ${activas} en cola` : activas ? `Enviando a Shares en segundo plano: ${activas} en cola` : 'Cola vacía: no hay asientos pendientes de envío'}</b>
        <div class="small muted">${(c.pausa_hasta ? `${esc(c.pausa_motivo || 'Shares limitó las solicitudes')}: el envío se reanuda solo a las ${esc(c.pausa_hasta)}. No se pierde nada.` : activas ? 'Se envían de a uno, en orden de fecha. Podés seguir trabajando o cerrar la pestaña.' : 'Últimas 6 horas')}${dudTxt}${rec.length ? ` · ${ok} cargados${mal.length ? ` · <b>${mal.length} con problemas</b>` : ''}` : ''}</div></div></div>
      ${mal.length ? `<details class="cola-err"><summary>Ver los que tuvieron problemas</summary><table><tbody>${mal.slice(0, 30).map(x => `<tr><td class="mono"><a href="#/asiento/${x.id}">${esc(x.ref || '#' + x.id)}</a></td><td>${badgeEstado(x.estado)}</td><td class="small">${esc(x.message || '')}</td></tr>`).join('')}</tbody></table></details>` : ''}
    </div>`;
    const d = $('[data-ir-dudosos]', caja); if (d) d.onclick = () => sessionStorage.setItem('asientos_grupo', 'dudoso');
    return activas;
  };
  const tick = async () => {
    if (!caja.isConnected) return;
    let c; try { c = await api('/api/cola/procesar', { method: 'POST' }); } catch { c = null; }
    if (!caja.isConnected) return;
    if (c) {
      const activas = pintar(c);
      if (antes !== null && activas < antes && alTerminar) { alTerminar(); return; }
      antes = activas;
      if (!activas) return;
    }
    setTimeout(tick, 15000);
  };
  tick();
}

// ---------------------------------------------------------------------------
//  Inicio
// ---------------------------------------------------------------------------
async function vistaInicio(el) {
  const t = await api('/api/tablero');
  contadores(t);
  const pe = t.por_estado || {};
  const n = (k) => pe[k]?.n || 0;
  const enviar = n('pendiente') + n('error'), errores = n('observado') + n('error');
  const primerNombre = String(S.user.nombre || '').split(' ')[0];
  const hora = new Date().getHours();
  const saludo = hora < 13 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
  const hoyTxt = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  el.innerHTML = `<div class="encabezado"><div><h1>${saludo}${primerNombre ? ', ' + esc(primerNombre) : ''}</h1><p>${esc(hoyTxt.charAt(0).toUpperCase() + hoyTxt.slice(1))} · cada asiento se envía una sola vez y queda con el número que asigna Shares</p></div>
      <div class="acciones"><a class="btn btn-acento" href="#/importar">${ICO.upload}Importar Excel</a></div></div>
    ${!t.empresas ? `<div class="panel panel-pad" style="margin-bottom:16px"><h2 style="margin-bottom:6px">Falta configurar las empresas</h2><p class="muted" style="margin:0 0 12px">Para cargar asientos, cada sociedad necesita su CUIT y el año del ejercicio tal como está en Shares.${puede('admin') ? '' : ' Pedíselo a un administrador.'}</p>${puede('admin') ? `<a class="btn btn-negro" href="#/admin" data-tab="1">${ICO.gear}Cargar empresas</a>` : ''}</div>` : ''}
    ${n('dudoso') ? `<a class="panel panel-pad aviso-pagos" href="#/asientos" data-grupo="dudoso" style="border-color:var(--warn);box-shadow:0 0 0 3px var(--warn-bg)">${ICO.alert}<span><b>${n('dudoso')} asiento${n('dudoso') > 1 ? 's' : ''} dudoso${n('dudoso') > 1 ? 's' : ''}.</b> Salió el pedido hacia Shares y no llegó la respuesta. Hay que fijarse en el ERP si quedó registrado. El resto de los asientos se sigue enviando.</span>${ICO.arrow}</a>` : ''}
    <div class="kpis">
      ${kpi('Para enviar', enviar, enviar ? $$m((pe.pendiente?.monto || 0) + (pe.error?.monto || 0)) : 'Nada pendiente', { href: '#/enviar' })}
      ${kpi('Con errores', errores, errores ? 'Corregilos antes de enviar' : 'Sin errores', { href: '#/asientos', clase: errores ? 'alerta' : '' })}
      ${kpi('En cola', n('en_cola') + n('enviando'), 'Se envían de a uno')}
      ${kpi('Cargados este mes', t.cargados_mes.n, t.cargados_mes.n ? $$m(t.cargados_mes.monto) : '—', { clase: t.cargados_mes.n ? 'ok' : '' })}
    </div>
    <div id="cola" style="margin-bottom:16px"></div>
    <div class="panel"><div class="panel-titulo"><h2>Últimos archivos subidos</h2><a class="btn btn-chico" href="#/lotes">Ver todos</a></div>
      ${t.lotes.length ? `<div class="panel-pad"><div class="lotes">${t.lotes.map(tarjetaLote).join('')}</div></div>` : `<div class="vacio"><span class="grande">Todavía no se subió ningún Excel</span>Empezá por “Importar Excel”.</div>`}
    </div>`;
  $$('[data-grupo]', el).forEach(a => a.onclick = () => sessionStorage.setItem('asientos_grupo', a.dataset.grupo));
  $$('[data-tab]', el).forEach(a => a.onclick = () => sessionStorage.setItem('admin_tab', a.dataset.tab));
  montarPanelCola(el, () => vistaInicio(el));
}

function tarjetaLote(l) {
  const n = (k) => Number(l[k]) || 0;
  const partes = [n('cargados') && `${n('cargados')} cargados`, n('pendientes') && `${n('pendientes')} para enviar`, n('en_cola') && `${n('en_cola')} en cola`,
    n('con_errores') && `<span class="txt-neg">${n('con_errores')} con errores</span>`, n('dudosos') && `<b class="txt-warn">${n('dudosos')} dudosos</b>`].filter(Boolean);
  const pend = n('pendientes') + n('con_errores') + n('dudosos');
  return `<a class="lote-card ${n('dudosos') ? 'pend' : ''}" href="#/lote/${l.id}">
    <div class="small muted">${esc(l.empresa || fmtCuit(l.cuit_empresa))} · ${fmtFH(l.creado_at)}</div>
    <div style="font:700 15px var(--display);margin:4px 0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.archivo_nombre || 'Excel')}</div>
    <div class="small">${n('n_actual')} asientos · ${$$m(l.total)}</div>
    <div class="small muted" style="margin-top:4px">${partes.join(' · ') || (n('descartados') === n('n_actual') ? 'Todos descartados' : '—')}</div>
    ${!pend && n('cargados') && n('cargados') + n('descartados') === n('n_actual') ? `<div class="small txt-pos" style="margin-top:6px">${ICO.check} Completo</div>` : ''}
  </a>`;
}

// ---------------------------------------------------------------------------
//  Importar Excel
// ---------------------------------------------------------------------------
async function vistaImportar(el) {
  const emps = (await empresas(true)).filter(e => e.activa);
  const elegida = emps.find(e => e.cuit === sessionStorage.getItem('imp_empresa')) || emps[0];
  el.innerHTML = `<div class="encabezado"><div><h1>Importar Excel</h1><p>Subí el archivo con los asientos. Antes de guardarlos, la app controla cada uno: que balancee, que las cuentas existan y reciban asientos, que la fecha esté dentro del ejercicio y que no esté repetido.</p></div>
      <div class="acciones"><button class="btn" id="b-modelo">${ICO.download}Descargar modelo</button></div></div>
    ${emps.length ? `<div class="panel panel-pad" style="margin-bottom:16px">
      <div class="fila" style="align-items:end">
        <div class="campo"><label for="imp-emp">Empresa</label><select id="imp-emp">${emps.map(e => `<option value="${e.cuit}" ${e.cuit === elegida?.cuit ? 'selected' : ''}>${esc(e.razon_social)} · ${fmtCuit(e.cuit)}</option>`).join('')}</select></div>
        <div class="campo"><label>Ejercicio en Shares</label><div id="imp-ej" class="mono" style="padding:9px 0"></div></div>
      </div>
      <label class="drop" id="drop" tabindex="0">${ICO.upload}<span>Arrastrá el Excel acá o tocá para elegirlo</span><small class="muted">.xlsx o .xls · un bloque por asiento (Fecha, renglones, Totales y observación) o una fila por renglón · lee todas las hojas</small><input type="file" id="f-xls" accept=".xlsx,.xls,.csv" hidden></label>
    </div>` : `<div class="panel panel-pad"><h2 style="margin-bottom:6px">No hay empresas configuradas</h2><p class="muted">Para importar, cargá la empresa con su CUIT y el año del ejercicio en Configuración → Empresas.</p></div>`}
    <div id="prev"></div>`;
  $('#b-modelo').onclick = descargarModelo;
  if (!emps.length) return;
  const sel = $('#imp-emp');
  const pintarEj = () => {
    const e = emps.find(x => x.cuit === sel.value);
    sessionStorage.setItem('imp_empresa', sel.value);
    $('#imp-ej').innerHTML = e?.periodo_contable ? `${esc(e.periodo_contable)}${e.pdesde && e.phasta ? ` <span class="muted">(${fmtF(e.pdesde)} al ${fmtF(e.phasta)})</span>` : ''} · ${e.cuentas ? `${e.cuentas} cuentas en el plan` : '<span class="txt-warn">sin plan de cuentas</span>'}` : '<span class="txt-neg">Falta el año del ejercicio</span>';
  };
  sel.onchange = () => { pintarEj(); if (S.ultimoArchivo) procesar(S.ultimoArchivo); };
  pintarEj();
  const drop = $('#drop'), inp = $('#f-xls');
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('sobre'); };
  drop.ondragleave = () => drop.classList.remove('sobre');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('sobre'); if (e.dataTransfer.files[0]) procesar(e.dataTransfer.files[0]); };
  inp.onchange = () => { if (inp.files[0]) procesar(inp.files[0]); inp.value = ''; };
  S.ultimoArchivo = null;

  async function procesar(file) {
    S.ultimoArchivo = file;
    const prev = $('#prev');
    prev.innerHTML = '<div class="panel vacio"><span class="cargando"></span><p>Leyendo y controlando…</p></div>';
    try {
      const p = parsearArchivo(await leerLibro(file));
      p.todos = p.asientos;
      await simular(prev, file, p);
    } catch (e) {
      prev.innerHTML = `<div class="panel panel-pad"><h2 style="margin-bottom:6px">No se pudo leer el archivo</h2><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  // Los asientos marcados "pasado" en el Excel ya se cargaron a mano en Shares: quedan afuera salvo que se pidan
  async function simular(prev, file, p) {
    p.asientos = p.incluirPasados ? p.todos : p.todos.filter(a => !a.pasado);
    if (!p.asientos.length) {
      prev.innerHTML = `<div class="panel panel-pad"><h2 style="margin-bottom:6px">No hay asientos nuevos en este archivo</h2>
        <p class="muted">Los ${p.todos.length} asientos tienen la marca “pasado” en la columna E: se cargaron a mano en Shares y no se vuelven a importar (Shares los duplicaría).</p>
        <label class="check"><input type="checkbox" id="incl-pas"> Importarlos igual (solo para revisarlos o descargar el resultado; no los envíes)</label></div>`;
      $('#incl-pas').onchange = () => { p.incluirPasados = true; simular(prev, file, p); };
      return;
    }
    const r = await api('/api/importar', { method: 'POST', body: { cuit_empresa: sel.value, simular: true, archivo_nombre: file.name, asientos: p.asientos } });
    pintarPrevia(prev, file, p, r);
  }

  function pintarPrevia(prev, file, p, r) {
    const rs = r.resumen;
    const nPas = p.todos.filter(a => a.pasado).length;
    const okN = rs.asientos - rs.con_errores;
    prev.innerHTML = `<div class="kpis">
        ${kpi('Asientos en el archivo', rs.asientos, $$m(rs.total))}
        ${kpi('Sin errores', okN, okN ? 'Quedan listos para enviar' : '—', { clase: okN ? 'ok' : '' })}
        ${kpi('Con errores', rs.con_errores, rs.con_errores ? 'Se corrigen en la app o en el Excel' : 'Ninguno', { clase: rs.con_errores ? 'alerta' : '' })}
        ${kpi('Posibles repetidos', rs.duplicados, rs.duplicados ? 'Iguales a otro asiento' : 'Ninguno', { clase: rs.duplicados ? 'alerta' : '' })}
      </div>
      ${p.avisos.length || nPas || p.info?.hojas?.length > 1 ? `<div class="panel panel-pad" style="margin-bottom:16px">
        ${p.info?.hojas?.length > 1 ? `<p class="con-ico small" style="margin:0 0 6px">${ICO.layers}Leí ${p.info.hojas.length} hojas: ${p.info.hojas.map(h => `${esc(h.hoja)} (${h.asientos})`).join(', ')}.</p>` : ''}
        ${p.avisos.map(a => `<p class="con-ico small" style="margin:0 0 6px">${ICO.info}${esc(a)}</p>`).join('')}
        ${nPas ? `<label class="check" style="margin:6px 0 0"><input type="checkbox" id="incl-pas" ${p.incluirPasados ? 'checked' : ''}> Incluir los ${nPas} marcados “pasado” en la columna E (ya cargados a mano en Shares: ${p.incluirPasados ? 'están incluidos, no los envíes' : 'quedan afuera'})</label>` : ''}
      </div>` : ''}
      <div class="panel"><div class="panel-titulo"><h2>${esc(file.name)}</h2><span class="ayuda">Tocá un asiento para ver sus renglones</span></div>
        <div class="tabla-wrap"><table><thead><tr><th>Asiento</th><th>Fecha</th><th>Observaciones</th><th class="num">Renglones</th><th class="num">Total</th><th>Controles</th></tr></thead><tbody>
        ${r.asientos.map((a, i) => {
          const loc = p.asientos[i] || {};
          const dup = a.duplicado ? `<span class="badge b-dudoso">Igual a #${a.duplicado.id} (${esc(ESTADOS[a.duplicado.estado] || a.duplicado.estado)})</span>` : (a.dup_en_archivo != null ? `<span class="badge b-dudoso">Repetido en el archivo (${esc(r.asientos[a.dup_en_archivo].ref)})</span>` : '');
          return `<tr class="click" data-i="${i}"><td class="mono"><b>${esc(a.ref)}</b><small class="sub-celda">${esc(loc.origen ? loc.origen.split(' · ').slice(1).join(' · ') || loc.origen : (a.fila ? 'fila ' + a.fila : ''))}</small></td><td class="mono">${a.fecha ? fmtF(a.fecha) : `<span class="txt-neg">${esc(a.fecha_original || 'falta')}</span>`}</td>
            <td style="max-width:300px"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.observaciones || '—')}</span></td><td class="num">${a.renglones.length}</td><td class="num">${$$m(a.total)}</td>
            <td><div class="chips">${loc.pasado ? '<span class="badge b-dudoso">Ya pasado a mano</span>' : ''}${a.errores.length ? `<span class="badge b-error">${a.errores.length} error${a.errores.length > 1 ? 'es' : ''}</span>` : '<span class="badge b-pendiente">OK</span>'}${a.avisos.length ? `<span class="badge b-aviso">${a.avisos.length} aviso${a.avisos.length > 1 ? 's' : ''}</span>` : ''}${dup}</div>
            ${a.errores.length ? `<small class="sub-celda" style="max-width:320px;overflow:hidden;text-overflow:ellipsis" title="${esc(a.errores.join('\n'))}">${esc(a.errores[0])}</small>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
        <div class="paginacion"><label class="check" style="margin:0">${rs.con_errores ? `<input type="checkbox" id="incl" checked> Guardar también los ${rs.con_errores} con errores (para corregirlos en la app)` : ''}</label>
          <div class="acciones"><button class="btn" id="b-otro">Elegir otro archivo</button><button class="btn btn-acento" id="b-guardar">${ICO.check}Guardar asientos</button></div></div>
      </div>`;
    $$('tr[data-i]', prev).forEach(tr => tr.onclick = () => modalPrevia(r.asientos[Number(tr.dataset.i)], p.asientos[Number(tr.dataset.i)]));
    if ($('#incl-pas')) $('#incl-pas').onchange = (e) => { p.incluirPasados = e.target.checked; simular(prev, file, p); };
    $('#b-otro').onclick = () => $('#f-xls').click();
    const guardar = $('#b-guardar');
    const actualizarBoton = () => { const n = ($('#incl')?.checked ?? true) ? rs.asientos : okN; guardar.innerHTML = `${ICO.check}Guardar ${n} asiento${n === 1 ? '' : 's'}`; guardar.disabled = !n; };
    if ($('#incl')) $('#incl').onchange = actualizarBoton;
    actualizarBoton();
    guardar.onclick = () => conBoton(guardar, async () => {
      if (p.incluirPasados && nPas && !await confirmar(`Vas a guardar ${nPas} asientos que ya están cargados a mano en Shares.\n\nQuedan en la app como “Listo para enviar”: si alguien los manda, se duplican en Shares. Descartalos después de revisarlos.`, { boton: 'Guardar igual' })) return;
      if (rs.duplicados && !await confirmar(`Hay ${rs.duplicados} asiento${rs.duplicados > 1 ? 's' : ''} igual${rs.duplicados > 1 ? 'es' : ''} a otro (misma empresa, fecha, cuentas e importes).\n\nSe guardan igual, pero no se van a poder enviar hasta que alguien confirme que de verdad van dos veces.`, { boton: 'Guardar igual' })) return;
      const x = await api('/api/importar', { method: 'POST', body: { cuit_empresa: sel.value, archivo_nombre: file.name, asientos: p.asientos.map(({ detalle, totales, fecha_raw, ...a }) => a), incluir_con_errores: $('#incl') ? $('#incl').checked : true } });
      S.cnt = null; S.ultimoArchivo = null;
      toast(`✓ ${x.guardados} asientos guardados`);
      location.hash = '#/lote/' + x.lote_id;
    });
  }
}

function modalPrevia(a, loc = {}) {
  const td = a.renglones.reduce((s, r) => s + cent(r.debe), 0), th = a.renglones.reduce((s, r) => s + cent(r.haber), 0);
  const det = (i) => loc.renglones?.[i]?.detalle || '';
  modal(`<h2>Asiento ${esc(a.ref)}</h2><p class="muted" style="margin-top:-8px">${a.fecha ? fmtF(a.fecha) : 'Sin fecha'} · ${esc(a.observaciones || 'Sin observaciones')}${loc.origen ? `<br><span class="small">${esc(loc.origen)}${loc.marca ? ' · marca: ' + esc(loc.marca) : ''}</span>` : ''}</p>
    ${problemasHtml({ errores: a.errores, avisos: a.avisos })}
    <div class="tabla-wrap"><table class="sin-orden"><thead><tr><th>Fila</th><th>Cuenta</th><th class="num">Debe</th><th class="num">Haber</th></tr></thead><tbody>
    ${a.renglones.map((r, i) => `<tr><td class="mono muted">${r.fila || ''}</td><td class="mono">${esc(r.codigo_cuenta ?? '—')}${det(i) ? `<small class="sub-celda">${esc(det(i))}</small>` : ''}</td><td class="num mono">${fmtImp(r.debe)}</td><td class="num mono">${fmtImp(r.haber)}</td></tr>`).join('')}
    <tr><td></td><td><b>Totales</b></td><td class="num mono"><b>${fmtNum.format(td / 100)}</b></td><td class="num mono"><b>${fmtNum.format(th / 100)}</b></td></tr></tbody></table></div>`, { ancho: true });
}

function problemasHtml(p, { vacio = '' } = {}) {
  const e = p?.errores || [], a = p?.avisos || [];
  if (!e.length && !a.length) return vacio;
  return `<ul class="hist" style="margin-bottom:14px">${e.map(x => `<li class="con-ico txt-neg">${ICO.x}<span>${esc(x)}</span></li>`).join('')}${a.map(x => `<li class="con-ico muted">${ICO.info}<span>${esc(x)}</span></li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------------------
//  Enviar a Shares
// ---------------------------------------------------------------------------
async function vistaEnviar(el) {
  await cargarYo().catch(() => null);
  const r = await api('/api/asientos?estado=pendiente,error&orden=cola&limite=1000');
  const tope = S.cfg.tope_por_envio;
  const aviso = !S.cfg.envio_habilitado
    ? `<div class="panel panel-pad aviso-pagos" style="border-color:var(--warn)">${ICO.alert}<span><b>El envío a Shares está apagado.</b> Los asientos se pueden importar y revisar, pero no se registran en Shares hasta que un administrador lo active en Configuración.</span>${puede('admin') ? `<a class="btn btn-chico" href="#/admin" data-tab="4">Configuración</a>` : ''}</div>`
    : (tope ? `<div class="panel panel-pad aviso-pagos">${ICO.info}<span><b>Modo prueba: hasta ${tope} asiento${tope > 1 ? 's' : ''} por envío.</b> Mandá uno, buscalo en Shares y verificá que esté bien antes de ampliar el tope. Shares no controla duplicados.</span></div>` : '');
  el.innerHTML = `<div class="encabezado"><div><h1>Enviar a Shares</h1><p>Asientos controlados y listos. Se mandan de a uno, en orden de fecha, y cada uno queda con el número que asigna Shares. Ninguno se envía dos veces.</p></div>
    <div class="acciones"><span class="muted" id="sel-info"></span><button class="btn btn-acento" id="b-env" disabled>${ICO.send}Aprobar y enviar</button></div></div>
    ${aviso}
    <div id="cola" style="margin-bottom:16px"></div>
    <div class="panel"><div class="tabla-wrap"><table><thead>${encabezadoAsientos({ check: true })}</thead>
    <tbody>${r.asientos.length ? r.asientos.map(a => filaAsiento(a, { check: true })).join('') : '<tr><td colspan="8" class="vacio"><span class="grande">No hay asientos para enviar</span>Los importados sin errores aparecen acá.</td></tr>'}</tbody></table></div></div>`;
  $$('[data-tab]', el).forEach(a => a.onclick = () => sessionStorage.setItem('admin_tab', a.dataset.tab));
  conectarFilas(el);
  const info = () => {
    const sel = $$('[data-sel]:checked');
    const tot = sel.reduce((s, x) => s + Number(x.dataset.total), 0);
    const pasado = tope && sel.length > tope;
    $('#sel-info').innerHTML = sel.length ? `${sel.length} elegido${sel.length > 1 ? 's' : ''} · ${$$m(tot)}${pasado ? ` · <span class="txt-neg">el tope es ${tope}</span>` : ''}` : '';
    $('#b-env').disabled = !sel.length || pasado || !puede('aprobador');
  };
  const todas = $('#todas');
  if (todas) todas.onchange = (e) => { $$('[data-sel]').forEach(c => { c.checked = e.target.checked; }); info(); };
  $$('[data-sel]').forEach(c => { c.onclick = (e) => e.stopPropagation(); c.onchange = info; });
  if (!puede('aprobador')) $('#sel-info').textContent = 'Envía un usuario con rol aprobador.';
  $('#b-env').onclick = () => conBoton($('#b-env'), async () => {
    const ids = $$('[data-sel]:checked').map(c => Number(c.dataset.sel));
    const dups = $$('[data-sel]:checked').filter(c => c.dataset.dup === '1').length;
    if (!await confirmar(`¿Enviar ${ids.length} asiento${ids.length > 1 ? 's' : ''} a Shares?\n\nSe registran de verdad en el ERP y se mandan en segundo plano, de a uno.${dups ? `\n\n${dups} figura${dups > 1 ? 'n' : ''} igual a otro asiento: no se va${dups > 1 ? 'n' : ''} a enviar hasta que se acepte el duplicado.` : ''}`, { boton: 'Sí, enviar' })) return;
    const x = await api('/api/enviar', { method: 'POST', body: { ids } });
    S.cnt = null;
    toast(`${x.encolados.length} en cola para Shares${x.rechazados.length ? ` · ${x.rechazados.length} no se pudieron encolar` : ''}`, !x.encolados.length && !!x.rechazados.length);
    await vistaEnviar(el);
    if (x.rechazados.length) modal(`<h2 style="margin-bottom:4px">${x.rechazados.length} no se encolaron</h2><p class="muted" style="margin:0 0 14px">${x.encolados.length ? 'Los demás ya están en cola.' : 'No se envió nada.'}</p>
      <div class="tabla-wrap"><table class="sin-orden"><tbody>${x.rechazados.map(z => `<tr><td class="mono"><a href="#/asiento/${z.id}">${esc(z.ref || '#' + z.id)}</a></td><td class="small">${esc(z.message)}</td></tr>`).join('')}</tbody></table></div>
      <div class="acciones" style="justify-content:flex-end;margin-top:14px"><button class="btn btn-acento" data-ok>Entendido</button></div>`, { ancho: true, alMontar: (m, c) => { $('[data-ok]', m).onclick = c; } });
  });
  montarPanelCola(el, () => vistaEnviar(el));
}

// ---------------------------------------------------------------------------
//  Asientos (todos, con filtros)
// ---------------------------------------------------------------------------
const GRUPOS = [
  ['todos', 'Todos', ''], ['pendiente', 'Para enviar', 'pendiente'], ['errores', 'Con errores', 'observado,error'],
  ['cola', 'En cola', 'en_cola,enviando'], ['dudoso', 'Dudosos', 'dudoso'], ['cargado', 'Cargados', 'cargado'], ['descartado', 'Descartados', 'descartado'],
];
async function vistaAsientos(el) {
  const emps = await empresas().catch(() => []);
  let grupo = sessionStorage.getItem('asientos_grupo') || 'todos';
  let q = sessionStorage.getItem('asientos_q') || '';
  sessionStorage.removeItem('asientos_q');
  let fEmp = sessionStorage.getItem('asientos_emp') || '', desde = '', hasta = '';
  el.innerHTML = `<div class="encabezado"><div><h1>Asientos</h1><p>Todo lo importado, con su estado. Tocá uno para ver los renglones, corregirlo o resolverlo.</p></div></div>
    <div class="seg" id="seg"></div>
    <div class="panel"><div class="filtros">
      <div class="campo ancho"><label for="q">Buscar</label><input id="q" placeholder="Asiento, observaciones, cuenta o N° de Shares" value="${esc(q)}"></div>
      <div class="campo"><label for="f-emp">Empresa</label><select id="f-emp"><option value="">Todas</option>${emps.map(e => `<option value="${e.cuit}" ${e.cuit === fEmp ? 'selected' : ''}>${esc(e.razon_social)}</option>`).join('')}</select></div>
      <div class="campo"><label for="f-d">Desde</label><input type="date" id="f-d"></div>
      <div class="campo"><label for="f-h">Hasta</label><input type="date" id="f-h"></div>
    </div><div class="tabla-wrap"><table><thead>${encabezadoAsientos()}</thead><tbody id="tb"><tr><td colspan="7" class="vacio"><span class="cargando"></span></td></tr></tbody></table></div>
    <div class="paginacion" id="pag"></div></div>`;
  let t;
  const cargar = async () => {
    const est = GRUPOS.find(g => g[0] === grupo)?.[2] || '';
    const p = new URLSearchParams({ limite: 300 });
    if (est) p.set('estado', est);
    if (q) p.set('q', q);
    if (fEmp) p.set('empresa', fEmp);
    if (desde) p.set('desde', desde);
    if (hasta) p.set('hasta', hasta);
    const r = await api('/api/asientos?' + p);
    const pe = r.por_estado || {};
    const cuenta = (g) => g[2] ? g[2].split(',').reduce((s, e) => s + (pe[e] || 0), 0) : Object.values(pe).reduce((s, n) => s + n, 0);
    $('#seg').innerHTML = GRUPOS.map(g => `<button data-g="${g[0]}" class="${g[0] === grupo ? 'on' : ''}">${g[1]} <b>${cuenta(g)}</b></button>`).join('');
    $$('#seg button').forEach(b => b.onclick = () => { grupo = b.dataset.g; sessionStorage.setItem('asientos_grupo', grupo); cargar(); });
    $('#tb').innerHTML = r.asientos.length ? r.asientos.map(a => filaAsiento(a)).join('') : '<tr><td colspan="7" class="vacio">No hay asientos con este filtro.</td></tr>';
    $('#pag').innerHTML = `<span>${r.asientos.length < r.total ? `Mostrando ${r.asientos.length} de ${r.total}` : `${r.total} asiento${r.total === 1 ? '' : 's'}`} · ${$$m(r.monto)}</span>`;
    conectarFilas(el);
  };
  $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); cargar(); }, 300); };
  $('#f-emp').onchange = (e) => { fEmp = e.target.value; sessionStorage.setItem('asientos_emp', fEmp); cargar(); };
  $('#f-d').onchange = (e) => { desde = e.target.value; cargar(); };
  $('#f-h').onchange = (e) => { hasta = e.target.value; cargar(); };
  await cargar();
}

// ---------------------------------------------------------------------------
//  Detalle de un asiento (renglones editables a la izquierda, controles y Shares a la derecha)
// ---------------------------------------------------------------------------
const ACCIONES_AUD = { importar: 'Importado', editar: 'Editado', encolar: 'Puesto en cola', enviar_shares: 'Envío a Shares', descartar: 'Descartado', reabrir: 'Reabierto',
  aceptar_duplicado: 'Duplicado aceptado', resolver_dudoso: 'Dudoso resuelto', envio_cortado: 'Envío cortado', quitar_de_cola: 'Sacado de la cola', control_previo: 'Control antes de enviar', anotar_numero: 'Número anotado' };

async function vistaAsiento(el, id) {
  const d = await api('/api/asientos/' + id);
  pintarAsiento(el, d);
}

function pintarAsiento(el, d) {
  const a = d.asiento;
  const editable = ['pendiente', 'observado', 'error'].includes(a.estado) && puede('carga');
  const totD = d.renglones.reduce((s, r) => s + cent(r.debe), 0), totH = d.renglones.reduce((s, r) => s + cent(r.haber), 0);
  const filaR = (r) => editable
    ? `<tr><td><input class="in-cuenta mono" list="dl-cuentas" data-c value="${esc(r.codigo_cuenta ?? '')}" inputmode="numeric" aria-label="Cuenta"><small class="sub-celda" data-den>${esc(r.denominacion || '')}</small></td>
        <td><input class="num" data-d value="${r.debe ? fmtNum.format(r.debe) : ''}" inputmode="decimal" aria-label="Debe"></td>
        <td><input class="num" data-h value="${r.haber ? fmtNum.format(r.haber) : ''}" inputmode="decimal" aria-label="Haber"></td>
        <td><button class="ibtn" data-quitar title="Quitar renglón" aria-label="Quitar renglón">${ICO.trash}</button></td></tr>`
    : `<tr><td class="mono"><b>${esc(r.codigo_cuenta)}</b>${r.denominacion ? `<small class="sub-celda">${esc(r.denominacion)}</small>` : ''}</td><td class="num mono">${fmtImp(r.debe)}</td><td class="num mono">${fmtImp(r.haber)}</td>${''}</tr>`;
  const dud = a.estado === 'dudoso';
  el.innerHTML = `<div class="encabezado"><div><a class="btn btn-ghost btn-chico" href="${a.lote_id ? '#/lote/' + a.lote_id : '#/asientos'}">${ICO.back}${a.lote_id ? 'Volver al archivo' : 'Asientos'}</a>
      <h1 style="margin-top:6px">Asiento ${esc(a.ref)} ${badgeEstado(a.estado)}</h1>
      <p>${esc(a.empresa || fmtCuit(a.cuit_empresa))} · ejercicio ${esc(a.emp_periodo || '—')} · #${a.id}${a.origen ? ` · ${esc(a.origen)}` : ''}${a.fila ? ` · fila ${a.fila} del Excel` : ''}${d.lote ? ` · <a href="#/lote/${d.lote.id}">${esc(d.lote.archivo_nombre || 'archivo')}</a>` : ''}</p></div>
    <div class="acciones" id="acc"></div></div>
    ${a.estado === 'en_cola' ? `<div id="aviso-cola"></div>` : ''}
    ${dud ? `<div class="panel panel-pad" style="margin-bottom:16px;border-color:var(--warn);box-shadow:0 0 0 3px var(--warn-bg)">
      <h2 style="margin-bottom:6px">Verificá en Shares si este asiento quedó registrado</h2>
      <p class="muted" style="margin:0 0 6px">${esc(a.mensaje || 'No se sabe si Shares lo registró.')}</p>
      <p style="margin:0 0 12px">Buscá en <b>${esc(a.empresa || a.cuit_empresa)}</b> un asiento del <b>${fmtF(a.fecha)}</b> por <b>${$$m(a.total)}</b>${a.observaciones ? ` con la observación “${esc(String(a.observaciones).slice(0, OBS_MAX))}”` : ''}. Mientras esté sin resolver, este asiento no se vuelve a enviar; el resto sigue normalmente.</p>
      ${puede('aprobador') ? `<div class="acciones"><button class="btn btn-acento" id="b-esta">${ICO.check}Sí, está en Shares</button><button class="btn" id="b-noesta">No está: volver a enviar más tarde</button></div>` : '<p class="small muted">Lo resuelve un usuario aprobador.</p>'}
    </div>` : ''}
    <div class="detalle">
      <div class="panel">
        <div class="panel-titulo"><h2>Renglones</h2><span class="ayuda">${d.hay_plan ? '' : 'Sin plan de cuentas cargado: las cuentas las controla Shares'}</span></div>
        ${editable ? `<div class="seccion"><div class="fila">
          <div class="campo"><label for="a-f">Fecha</label><input type="date" id="a-f" value="${esc(a.fecha || '')}"></div>
          <div class="campo" style="grid-column:span 2"><label for="a-o">Observaciones <span class="muted" id="a-oc"></span></label><input id="a-o" value="${esc(a.observaciones || '')}" maxlength="250"></div>
        </div></div>` : `<div class="seccion"><dl class="kv"><dt>Fecha</dt><dd>${fmtF(a.fecha)}</dd><dt>Observaciones</dt><dd style="font-family:var(--sans)">${esc(a.observaciones || '—')}</dd></dl></div>`}
        <div class="tabla-wrap"><table class="sin-orden"><thead><tr><th>Cuenta</th><th class="num">Debe</th><th class="num">Haber</th>${editable ? '<th></th>' : ''}</tr></thead>
          <tbody id="ren">${d.renglones.map(filaR).join('')}</tbody>
          <tfoot><tr><td><b>Totales</b> <span id="dif" class="small"></span></td><td class="num mono"><b id="t-d">${fmtNum.format(totD / 100)}</b></td><td class="num mono"><b id="t-h">${fmtNum.format(totH / 100)}</b></td>${editable ? '<td></td>' : ''}</tr></tfoot></table></div>
        ${editable ? `<div class="paginacion"><button class="btn btn-chico" id="b-add">${ICO.plus}Agregar renglón</button><div class="acciones"><button class="btn btn-negro" id="b-guardar">Guardar y controlar</button></div></div><datalist id="dl-cuentas"></datalist>` : ''}
      </div>
      <div class="lado">
        <div class="panel"><div class="panel-titulo"><h2>Controles</h2>${['pendiente', 'observado', 'error'].includes(a.estado) ? '<button class="btn btn-chico" id="b-recontrolar">Volver a controlar</button>' : ''}</div>
          <div class="panel-pad">${problemasHtml(d.problemas, { vacio: `<p class="con-ico txt-pos" style="margin:0">${ICO.check}Balancea y pasó todos los controles.</p>` })}
          ${d.duplicado ? `<div class="panel panel-pad" style="margin-top:4px;background:var(--surface-2)"><b>Igual al asiento <a href="#/asiento/${d.duplicado.id}">${esc(d.duplicado.ref)} (#${d.duplicado.id})</a></b>
            <div class="small muted">${esc(ESTADOS[d.duplicado.estado] || d.duplicado.estado)}${d.duplicado.shares_numero ? ` · N° ${d.duplicado.shares_numero} en Shares` : ''} · misma empresa, fecha, cuentas e importes.</div>
            ${a.dup_aceptado ? `<p class="small" style="margin:8px 0 0">Aceptado por ${esc(JSON.parse(a.dup_aceptado).por)}: “${esc(JSON.parse(a.dup_aceptado).comentario)}”</p>`
              : (['pendiente', 'observado', 'error'].includes(a.estado) && puede('aprobador') ? `<button class="btn btn-chico" id="b-dup" style="margin-top:8px">Va dos veces: aceptar el duplicado</button>` : '')}</div>` : ''}
          </div></div>
        <div class="panel"><div class="panel-titulo"><h2>Shares</h2></div><div class="panel-pad">
          <dl class="kv"><dt>Estado</dt><dd style="font-family:var(--sans)">${badgeEstado(a.estado)}</dd>
            <dt>N° de asiento</dt><dd>${a.shares_numero ? esc(a.shares_numero) : '—'}</dd>
            ${a.enviado_at ? `<dt>Enviado</dt><dd>${fmtFH(a.enviado_at)} · ${esc(a.enviado_por || '')}</dd>` : ''}
            ${a.intentos ? `<dt>Intentos</dt><dd>${a.intentos}</dd>` : ''}
            ${a.mensaje && !dud ? `<dt>Mensaje</dt><dd style="font-family:var(--sans)">${esc(a.mensaje)}</dd>` : ''}</dl>
          ${a.estado === 'cargado' && !a.shares_numero && puede('aprobador') ? '<button class="btn btn-chico" id="b-nro" style="margin-top:10px">Anotar el número de Shares</button>' : ''}
          ${d.payload ? `<details style="margin-top:12px"><summary class="small">Lo que se mandó a Shares</summary><pre class="mono small" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(d.payload, null, 2))}</pre></details>` : ''}
          ${d.respuesta ? `<details style="margin-top:6px"><summary class="small">Lo que respondió Shares</summary><pre class="mono small" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(d.respuesta, null, 2))}</pre></details>` : ''}
        </div></div>
        <div class="panel"><div class="panel-titulo"><h2>Historial</h2></div><div class="panel-pad"><ul class="hist">
          ${d.auditoria.map(h => `<li><b>${esc(ACCIONES_AUD[h.accion] || h.accion)}</b> <span class="muted small">· ${fmtFH(h.ts)} · ${esc(h.usuario || '')}</span>${h.accion !== 'editar' && h.valor_nuevo ? `<div class="small muted" style="overflow-wrap:anywhere">${esc(String(h.valor_nuevo).slice(0, 220))}</div>` : ''}</li>`).join('') || '<li class="muted">Sin movimientos.</li>'}
        </ul></div></div>
      </div>
    </div>`;

  if (a.estado === 'en_cola') api('/api/cola').then(c => {
    const box = $('#aviso-cola'); if (!box) return;
    if (!c.envio_habilitado) box.innerHTML = `<div class="panel panel-pad aviso-pagos">${ICO.info}<span><b>El envío a Shares está apagado:</b> sale cuando se active en Configuración.</span></div>`;
    else if (c.pausa_hasta) box.innerHTML = `<div class="panel panel-pad aviso-pagos">${ICO.clock}<span>${esc(c.pausa_motivo || 'Shares en pausa')}: se retoma a las ${esc(c.pausa_hasta)}.</span></div>`;
    const v = $('[data-dud]', box); if (v) v.onclick = () => sessionStorage.setItem('asientos_grupo', 'dudoso');
  }).catch(() => null);

  // Acciones del encabezado
  const acc = $('#acc');
  const botones = [];
  if (['pendiente', 'observado', 'error'].includes(a.estado) && puede('carga')) botones.push(`<button class="btn btn-rojo" id="b-desc">${ICO.x}Descartar</button>`);
  if (a.estado === 'descartado' && puede('aprobador')) botones.push(`<button class="btn" id="b-reab">${ICO.refresh}Reabrir</button>`);
  if (['pendiente', 'error'].includes(a.estado)) botones.push(`<a class="btn btn-acento" href="#/enviar">${ICO.send}Ir a enviar</a>`);
  if (a.estado === 'en_cola' && puede('aprobador')) botones.push(`<button class="btn" id="b-quitar">${ICO.x}Sacar de la cola</button>`);
  acc.innerHTML = botones.join('');
  const recargar = (x) => { S.cnt = null; pintarAsiento(el, x); };
  const post = (accion, body) => api(`/api/asientos/${a.id}/${accion}`, { method: 'POST', body });
  $('#b-desc')?.addEventListener('click', async () => { const m = await pedirTexto({ titulo: 'Descartar asiento', ayuda: 'No se va a enviar a Shares. Queda en el historial y se puede reabrir.', etiqueta: 'Motivo', boton: 'Descartar' }); if (m) conBoton($('#b-desc'), async () => recargar(await post('descartar', { motivo: m }))); });
  $('#b-quitar')?.addEventListener('click', () => conBoton($('#b-quitar'), async () => {
    const x = await api('/api/cola/quitar', { method: 'POST', body: { ids: [a.id] } });
    if (!x.quitados) { toast('Ya salió hacia Shares: no se puede sacar.', true); }
    else toast('Sacado de la cola: volvió a “Para enviar”');
    recargar(await api('/api/asientos/' + a.id));
  }));
  $('#b-reab')?.addEventListener('click', () => conBoton($('#b-reab'), async () => recargar(await post('reabrir', {}))));
  $('#b-recontrolar')?.addEventListener('click', () => conBoton($('#b-recontrolar'), async () => { recargar(await post('recontrolar', {})); toast('Controlado de nuevo'); }));
  $('#b-dup')?.addEventListener('click', async () => { const m = await pedirTexto({ titulo: 'Aceptar el duplicado', ayuda: `Este asiento es igual al #${d.duplicado.id}. Si de verdad va dos veces (por ejemplo, dos transferencias iguales el mismo día), explicá por qué.`, etiqueta: 'Por qué va dos veces', boton: 'Aceptar' }); if (m) conBoton($('#b-dup'), async () => recargar(await post('aceptar-duplicado', { comentario: m }))); });
  $('#b-nro')?.addEventListener('click', async () => { const n = await pedirTexto({ titulo: 'Número de asiento en Shares', etiqueta: 'N° de asiento', boton: 'Guardar', minimo: 1 }); if (n) conBoton($('#b-nro'), async () => recargar(await post('anotar-numero', { numero: n }))); });
  $('#b-esta')?.addEventListener('click', () => modal(`<h2>Está en Shares</h2><p class="muted" style="margin-top:-6px">Queda como cargado con el número que ves en el ERP. No se vuelve a enviar.</p>
      <form id="f-esta"><div class="campo"><label>N° de asiento en Shares</label><input name="numero" inputmode="numeric" class="mono" required></div>
      <div class="campo"><label>Qué viste (ej. “Asiento 1234 del 04/09, mismo importe”)</label><input name="comentario" required minlength="5"></div>
      <button class="btn btn-acento" type="submit">Confirmar</button></form>`, { alMontar: (m, cerrar) => { $('#f-esta', m).onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { const x = await post('resolver', { accion: 'cargado', ...Object.fromEntries(new FormData(e.target)) }); cerrar(); recargar(x); toast('Asiento confirmado: la cola sigue sola'); }); }; } }));
  $('#b-noesta')?.addEventListener('click', async () => {
    const m = await pedirTexto({ titulo: 'No está en Shares', ayuda: 'Vuelve a “Para enviar”. Confirmalo solo si lo buscaste y no está: si estuviera, se duplicaría.', etiqueta: 'Dónde lo buscaste', boton: 'Volver a pendiente' });
    if (m) conBoton($('#b-noesta'), async () => { recargar(await post('resolver', { accion: 'no_cargado', comentario: m })); toast('Volvió a “Para enviar”'); });
  });

  if (!editable) return;
  // Editor de renglones
  const tb = $('#ren');
  let plan = null;
  api('/api/cuentas?empresa=' + a.cuit_empresa).then(r => {
    plan = new Map(r.cuentas.map(c => [String(c.codigo), c]));
    const dl = $('#dl-cuentas'); if (dl) dl.innerHTML = r.cuentas.filter(c => c.imputable).map(c => `<option value="${c.codigo}">${esc(c.denominacion)}</option>`).join('');
  }).catch(() => null);
  const leerMonto = (v) => montoCelda(String(v || '').trim());
  const totales = () => {
    let dd = 0, hh = 0;
    $$('tr', tb).forEach(tr => { dd += cent(leerMonto($('[data-d]', tr).value)); hh += cent(leerMonto($('[data-h]', tr).value)); });
    $('#t-d').textContent = fmtNum.format(dd / 100); $('#t-h').textContent = fmtNum.format(hh / 100);
    $('#dif').innerHTML = dd === hh ? (dd ? '<span class="txt-pos">balancea</span>' : '') : `<span class="txt-neg">diferencia ${fmtNum.format(Math.abs(dd - hh) / 100)}</span>`;
  };
  const conectar = (tr) => {
    $('[data-quitar]', tr).onclick = () => { tr.remove(); totales(); };
    $$('[data-d],[data-h]', tr).forEach(i => { i.oninput = totales; i.onblur = () => { const n = leerMonto(i.value); i.value = n ? fmtNum.format(n) : ''; }; });
    const c = $('[data-c]', tr);
    c.oninput = () => { const x = plan?.get(c.value.trim()); $('[data-den]', tr).textContent = x ? x.denominacion + (x.imputable ? '' : ' (no recibe asientos)') : ''; };
  };
  $$('tr', tb).forEach(conectar);
  $('#b-add').onclick = () => { tb.insertAdjacentHTML('beforeend', filaR({ codigo_cuenta: '', debe: 0, haber: 0 })); conectar(tb.lastElementChild); $('[data-c]', tb.lastElementChild).focus(); };
  const oc = () => { const n = $('#a-o').value.length; $('#a-oc').innerHTML = n > OBS_MAX ? `<span class="txt-neg">${n}/${OBS_MAX}: Shares guarda solo los primeros ${OBS_MAX}</span>` : `${n}/${OBS_MAX}`; };
  $('#a-o').oninput = oc; oc(); totales();
  $('#b-guardar').onclick = () => conBoton($('#b-guardar'), async () => {
    const renglones = $$('tr', tb).map(tr => ({ codigo_cuenta: $('[data-c]', tr).value.trim(), debe: leerMonto($('[data-d]', tr).value), haber: leerMonto($('[data-h]', tr).value) }))
      .filter(r => r.codigo_cuenta || r.debe || r.haber);
    const x = await api('/api/asientos/' + a.id, { method: 'PUT', body: { fecha: $('#a-f').value, observaciones: $('#a-o').value, renglones } });
    recargar(x);
    toast(x.resultado === 'pendiente' ? '✓ Guardado: listo para enviar' : 'Guardado, pero todavía tiene errores', x.resultado !== 'pendiente');
  });
}

// ---------------------------------------------------------------------------
//  Archivos subidos (lotes)
// ---------------------------------------------------------------------------
async function vistaLotes(el) {
  const r = await api('/api/lotes');
  el.innerHTML = `<div class="encabezado"><div><h1>Archivos subidos</h1><p>Cada Excel importado, con el avance de sus asientos. Desde cada uno se descarga el Excel con el número que asignó Shares.</p></div>
    <div class="acciones"><a class="btn btn-acento" href="#/importar">${ICO.upload}Importar Excel</a></div></div>
    ${r.lotes.length ? `<div class="lotes">${r.lotes.map(tarjetaLote).join('')}</div>` : '<div class="panel vacio"><span class="grande">Todavía no se subió ningún Excel</span></div>'}`;
}

async function vistaLote(el, id) {
  const d = await api('/api/lotes/' + id);
  const L = d.lote, as = d.asientos;
  const cnt = (f) => as.filter(f).length;
  const enviables = as.filter(a => ['pendiente', 'error'].includes(a.estado));
  el.innerHTML = `<div class="encabezado"><div><a class="btn btn-ghost btn-chico" href="#/lotes">${ICO.back}Archivos subidos</a>
      <h1 style="margin-top:6px">${esc(L.archivo_nombre || 'Excel')}</h1><p>${esc(L.empresa || fmtCuit(L.cuit_empresa))} · subido el ${fmtFH(L.creado_at)} por ${esc(L.creado_por || '')}</p></div>
    <div class="acciones"><button class="btn" id="b-exp">${ICO.download}Descargar Excel con resultados</button>${enviables.length ? `<a class="btn btn-acento" href="#/enviar">${ICO.send}Enviar a Shares</a>` : ''}</div></div>
    <div class="kpis">
      ${kpi('Asientos', as.length, $$m(as.filter(a => a.estado !== 'descartado').reduce((s, a) => s + (a.total || 0), 0)))}
      ${kpi('Cargados en Shares', cnt(a => a.estado === 'cargado'), '', { clase: cnt(a => a.estado === 'cargado') ? 'ok' : '' })}
      ${kpi('Para enviar', enviables.length, cnt(a => ['en_cola', 'enviando'].includes(a.estado)) ? `${cnt(a => ['en_cola', 'enviando'].includes(a.estado))} en cola` : '')}
      ${kpi('Con errores o dudosos', cnt(a => ['observado', 'error', 'dudoso'].includes(a.estado)), '', { clase: cnt(a => ['observado', 'error', 'dudoso'].includes(a.estado)) ? 'alerta' : '' })}
    </div>
    <div class="panel"><div class="tabla-wrap"><table><thead>${encabezadoAsientos({ empresa: false })}</thead>
    <tbody>${as.map(a => filaAsiento(a, { empresa: false })).join('')}</tbody></table></div></div>`;
  conectarFilas(el);
  $('#b-exp').onclick = () => {
    const filas = [['Asiento', 'Origen', 'Fila Excel', 'Fecha', 'Cuenta', 'Denominación', 'Debe', 'Haber', 'Observaciones', 'Estado', 'N° asiento Shares', 'ID app', 'Mensaje']];
    for (const a of as) for (const [i, r] of a.renglones_detalle.entries()) {
      filas.push([a.ref, i === 0 ? a.origen || '' : '', r.fila || (i === 0 ? a.fila || '' : ''), fmtF(a.fecha), r.codigo_cuenta, r.denominacion || '', r.debe || '', r.haber || '',
        i === 0 ? a.observaciones || '' : '', ESTADOS[a.estado] || a.estado, a.shares_numero || '', a.id, i === 0 ? (a.mensaje || (a.problemas?.errores || []).join(' ')) : '']);
    }
    descargarXlsx(`${String(L.archivo_nombre || 'asientos').replace(/\.[^.]+$/, '')} - resultado.xlsx`, [['Resultado', filas, [22, 40, 9, 11, 8, 28, 15, 15, 40, 20, 14, 8, 50]]]);
  };
}

// ---------------------------------------------------------------------------
//  Configuración (admin)
// ---------------------------------------------------------------------------
async function vistaAdmin(el) {
  if (!puede('admin')) { el.innerHTML = '<div class="panel panel-pad">Solo para administradores.</div>'; return; }
  const nombres = ['Salud', 'Empresas', 'Plan de cuentas', 'Usuarios', 'Envío a Shares', 'Auditoría'];
  el.innerHTML = `<div class="encabezado"><div><h1>Configuración</h1><p>Conexión con Shares, empresas y ejercicios, plan de cuentas, usuarios y auditoría.</p></div></div>
    <div class="panel"><div class="tabs" id="atabs">${nombres.map((t, i) => `<button data-t="${i}">${t}</button>`).join('')}</div><div id="acont" class="panel-pad"></div></div>`;
  const tabs = [adminSalud, adminEmpresas, adminCuentas, adminUsuarios, adminConfig, adminAuditoria];
  const ir = async (i) => {
    sessionStorage.setItem('admin_tab', i);
    $$('#atabs button').forEach(b => b.classList.toggle('activo', b.dataset.t === String(i)));
    $('#acont').innerHTML = '<span class="cargando"></span>';
    try { await tabs[i]($('#acont')); } catch (e) { $('#acont').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  };
  $$('#atabs button').forEach(b => b.onclick = () => ir(Number(b.dataset.t)));
  ir(Math.min(Number(sessionStorage.getItem('admin_tab')) || 0, tabs.length - 1));
}

async function adminSalud(el) {
  const s = await api('/api/salud');
  const fila = (ok, t, det, prueba) => `<tr><td>${ok ? '<span class="badge b-ok">OK</span>' : '<span class="badge b-normal">Falta</span>'}</td><td><b>${t}</b><div class="small muted">${det}</div></td><td>${prueba ? `<button class="btn btn-chico" data-probar="${prueba}">Probar</button>` : ''}</td></tr>`;
  const u = s.shares_uso_hora || {}, dd = s.shares_uso_dia || {};
  el.innerHTML = `<table class="sin-orden"><tbody>
    ${fila(s.shares, 'Shares', `${esc(s.shares_base)}${s.shares ? '' : ' · faltan SHARES_USERNAME y SHARES_PASSWORD en el Worker'}`, 'shares')}
    ${fila(!u.frenadas && !s.shares_pausa_hasta, 'Uso de Shares', `Última hora: <b>${u.llamadas || 0}</b> llamadas · ${u.frenadas || 0} frenadas · Últimas 24 h: ${dd.llamadas || 0} llamadas${s.shares_pausa_hasta ? `<br><b>En pausa hasta las ${esc(s.shares_pausa_hasta)}</b>: ${esc(s.shares_pausa_motivo || '')}` : ''}`)}
    ${fila(s.envio_habilitado, 'Envío a Shares', s.envio_habilitado ? (s.tope_por_envio ? `Activo en modo prueba: hasta ${s.tope_por_envio} por envío` : 'Activo, sin tope') : 'Apagado: se importa y controla, pero no se registra nada')}
    ${fila(s.empresas > 0 && !s.empresas_sin_ejercicio, 'Empresas', `${s.empresas} activas${s.empresas_sin_ejercicio ? ` · <b>${s.empresas_sin_ejercicio} sin año o fechas del ejercicio</b>` : ''}`)}
    ${fila(s.empresas_con_plan >= s.empresas && s.empresas > 0, 'Plan de cuentas', `${s.empresas_con_plan} de ${s.empresas} empresas con plan cargado (sin plan, las cuentas las controla Shares al enviar)`)}
  </tbody></table><p class="small muted">Versión del servidor ${esc(s.version)} · origen permitido ${esc(s.origen)}</p>`;
  $$('[data-probar]', el).forEach(b => b.onclick = () => conBoton(b, async () => { const r = await api('/api/probar/' + b.dataset.probar, { method: 'POST' }); toast(r.mensaje); }));
}

async function adminEmpresas(el) {
  const r = await api('/api/empresas');
  S.empresas = r.empresas;
  el.innerHTML = `<div class="acciones" style="margin-bottom:12px"><button class="btn btn-negro" id="b-fact">${ICO.download}Traer de la app de facturas</button><button class="btn" id="b-ne">${ICO.plus}Nueva empresa a mano</button></div>
    <p class="small muted">El año del ejercicio es el que tiene abierto Shares para la empresa. Si no lo sabés, dejá el año en curso: si no coincide, Shares rechaza el primer asiento (sin registrar nada), avisa cuál es el correcto y la app lo corrige sola. Las fechas de inicio y cierre son opcionales.</p>
    <div class="tabla-wrap"><table><thead><tr><th>CUIT</th><th>Razón social</th><th>Año</th><th>Ejercicio</th><th class="num">Cuentas</th><th>Estado</th><th></th></tr></thead><tbody>
    ${r.empresas.map(e => `<tr><td class="mono">${fmtCuit(e.cuit)}</td><td>${esc(e.razon_social)}</td><td class="mono">${esc(e.periodo_contable || '—')}</td>
      <td class="mono">${e.pdesde && e.phasta ? `${fmtF(e.pdesde)} al ${fmtF(e.phasta)}` : '<span class="txt-warn">sin fechas</span>'}</td><td class="num">${e.cuentas || '—'}</td>
      <td>${e.activa ? 'Activa' : '<span class="muted">Inactiva</span>'}</td><td class="acciones"><button class="btn btn-chico" data-ed="${e.cuit}">Editar</button><button class="btn btn-chico btn-rojo" data-del="${e.cuit}">Quitar</button></td></tr>`).join('') || '<tr><td colspan="7" class="vacio">Sin empresas cargadas.</td></tr>'}
    </tbody></table></div>`;
  const form = (e = {}) => modal(`<h2>${e.cuit && !e.nueva ? 'Editar empresa' : 'Nueva empresa'}</h2><form id="f-emp">
      <div class="fila"><div class="campo"><label>CUIT</label><input name="cuit" class="mono" value="${esc(e.cuit || '')}" ${e.cuit ? 'readonly' : ''} required></div>
      <div class="campo"><label>Año del ejercicio en Shares</label><input name="periodo_contable" class="mono" inputmode="numeric" value="${esc(e.periodo_contable || new Date().getFullYear())}" required></div></div>
      <div class="ayuda" style="margin:-4px 0 12px">Si no estás seguro, dejá el año en curso: si Shares tiene otro, lo avisa en el primer envío y la app lo corrige.</div>
      <div class="campo"><label>Razón social</label><input name="razon_social" value="${esc(e.razon_social || '')}" required></div>
      <div class="fila"><div class="campo"><label>Inicio del ejercicio</label><input type="date" name="pdesde" value="${esc(e.pdesde || '')}"></div><div class="campo"><label>Cierre del ejercicio</label><input type="date" name="phasta" value="${esc(e.phasta || '')}"></div></div>
      <div class="ayuda" style="margin:-4px 0 12px">Opcionales. Si el ejercicio cierra el 31/12, es del 01/01 al 31/12 de ese año. Con las fechas, la app avisa antes de enviar un asiento fuera del ejercicio; sin ellas, lo controla Shares.</div>
      <label class="check"><input type="checkbox" name="activa" ${e.activa === 0 ? '' : 'checked'}> Activa</label>
      <button class="btn btn-negro" type="submit">Guardar</button></form>`, {
    alMontar: (m, cerrar) => { $('#f-emp', m).onsubmit = (ev) => { ev.preventDefault(); const b = Object.fromEntries(new FormData(ev.target)); b.activa = !!ev.target.elements.activa.checked; conBoton($('button[type=submit]', ev.target), async () => { await api('/api/empresas', { method: 'POST', body: b }); cerrar(); toast('Empresa guardada'); S.empresas = null; adminEmpresas(el); }); }; },
  });
  $('#b-ne', el).onclick = () => form();
  // Las dos apps están en el mismo sitio (juanluccianos.github.io): si ya entraste a facturas en este navegador,
  // se usa esa sesión para leer sus empresas (solo lectura; no se toca nada de facturas).
  $('#b-fact', el).onclick = () => conBoton($('#b-fact', el), async () => {
    let tokF = null, apiF = 'https://facturas-api.lucciano-viaticos.workers.dev';
    try { tokF = localStorage.getItem('facturas_token'); apiF = (localStorage.getItem('facturas_api') || apiF).replace(/\/$/, ''); } catch { }
    const sinSesion = () => modal(`<h2>Primero entrá a la app de facturas</h2><p>Para leer las empresas necesito tu sesión de facturas en <b>este mismo navegador</b>.</p>
      <p class="muted">Abrí la app de facturas, ingresá con tu usuario, volvé a esta pestaña y tocá de nuevo “Traer de la app de facturas”.</p>
      <div class="acciones" style="justify-content:flex-end"><a class="btn btn-negro" href="https://juanluccianos.github.io/facturasluccianos/" target="_blank" rel="noopener">Abrir facturas</a></div>`);
    if (!tokF) return sinSesion();
    let lista;
    try {
      const res = await fetch(apiF + '/api/empresas', { headers: { Authorization: 'Bearer ' + tokF } });
      if (res.status === 401) return sinSesion();
      if (!res.ok) throw new Error('HTTP ' + res.status);
      lista = (await res.json()).empresas || [];
    } catch (e) { throw new Error('No pude leer las empresas de facturas (' + e.message + ').'); }
    const ya = new Set(r.empresas.map(x => x.cuit));
    if (!lista.length) { toast('La app de facturas no tiene empresas cargadas.', true); return; }
    modal(`<h2>Empresas de la app de facturas</h2><p class="muted" style="margin-top:-6px">Elegí cuál agregar. Después confirmás el año del ejercicio.</p>
      <div class="tabla-wrap"><table class="sin-orden"><tbody>${lista.map(x => `<tr><td class="mono">${fmtCuit(x.cuit)}</td><td>${esc(x.razon_social)}</td>
        <td class="num">${ya.has(x.cuit) ? '<span class="badge b-ok">Ya está</span>' : `<button class="btn btn-chico btn-negro" data-agregar="${esc(x.cuit)}">Agregar</button>`}</td></tr>`).join('')}</tbody></table></div>`, {
      ancho: true,
      alMontar: (m, cerrar) => $$('[data-agregar]', m).forEach(b => b.onclick = () => { const x = lista.find(y => y.cuit === b.dataset.agregar); cerrar(); form({ cuit: x.cuit, razon_social: x.razon_social, nueva: true }); }),
    });
  });
  $$('[data-ed]', el).forEach(b => b.onclick = () => form(r.empresas.find(x => x.cuit === b.dataset.ed)));
  $$('[data-del]', el).forEach(b => b.onclick = async () => await confirmar('¿Quitar esta empresa y su plan de cuentas?') && conBoton(b, async () => { await api('/api/empresas/' + b.dataset.del, { method: 'DELETE' }); S.empresas = null; adminEmpresas(el); }));
}

async function adminCuentas(el) {
  const emps = await empresas(true);
  if (!emps.length) { el.innerHTML = '<p class="muted">Primero cargá las empresas.</p>'; return; }
  let cuit = sessionStorage.getItem('plan_emp') || emps[0].cuit;
  if (!emps.some(e => e.cuit === cuit)) cuit = emps[0].cuit;
  el.innerHTML = `<div class="filtros" style="padding:0 0 14px;border:0">
      <div class="campo"><label for="pe">Empresa</label><select id="pe">${emps.map(e => `<option value="${e.cuit}" ${e.cuit === cuit ? 'selected' : ''}>${esc(e.razon_social)}</option>`).join('')}</select></div>
      <div class="campo ancho"><label for="pq">Filtrar</label><input id="pq" placeholder="Código o denominación"></div>
      <div class="campo"><div class="acciones"><button class="btn btn-negro" id="b-shares">${ICO.refresh}Traer de Shares</button><button class="btn" id="b-imp">${ICO.upload}Importar Excel</button></div></div></div>
    <p class="small muted">El código es el de Shares para asientos (el legajo de la cuenta, hasta 3 dígitos). “Traer de Shares” usa el mismo catálogo que la app de facturas. Las cuentas destildadas no reciben asientos (títulos, cuentas madre).</p>
    <div id="pl"></div>`;
  const cargar = async () => {
    const r = await api('/api/cuentas?empresa=' + cuit);
    $('#pl', el).innerHTML = r.cuentas.length ? `<div class="tabla-wrap tabla-scroll"><table><thead><tr><th>Recibe asientos</th><th>Código</th><th>Denominación</th></tr></thead><tbody id="tbc">
      ${r.cuentas.map(c => `<tr data-txt="${esc((c.codigo + ' ' + c.denominacion).toLowerCase())}"><td><input type="checkbox" data-cta="${c.codigo}" ${c.imputable ? 'checked' : ''}></td><td class="mono">${c.codigo}</td><td>${esc(c.denominacion)}</td></tr>`).join('')}</tbody></table></div><p class="small muted">${r.cuentas.length} cuentas.</p>`
      : '<div class="vacio">Esta empresa no tiene plan de cuentas cargado.</div>';
    $$('[data-cta]', el).forEach(c => c.onchange = () => api(`/api/cuentas/${cuit}/${c.dataset.cta}`, { method: 'PUT', body: { imputable: c.checked } }).then(() => toast('Guardado')).catch(e => toast(e.message, true)));
    $('#pq', el).dispatchEvent(new Event('input'));
  };
  $('#pe', el).onchange = (e) => { cuit = e.target.value; sessionStorage.setItem('plan_emp', cuit); cargar(); };
  $('#pq', el).oninput = (e) => { const q = e.target.value.toLowerCase(); $$('#tbc tr', el).forEach(tr => tr.classList.toggle('hidden', !!q && !tr.dataset.txt.includes(q))); };
  const traer = async (campo = null) => {
    const r = await api('/api/cuentas/traer-shares', { method: 'POST', body: { cuit_empresa: cuit, campo } });
    if (r.ok) {
      toast(`✓ ${r.cantidad} cuentas traídas de Shares`);
      await cargar();
      if (await confirmar('¿Volver a controlar los asientos que todavía no se enviaron con el plan nuevo?', { boton: 'Sí, controlar' })) await recontrolarTodos();
      return;
    }
    const motivo = { sin_legajo: 'Shares devolvió el catálogo, pero no encontré un campo con el <b>legajo</b> de la cuenta (el número de hasta 3 dígitos que piden los asientos: 7, 6, 498…).',
      legajo_largo: `El campo <b>${esc(r.campo)}</b> trae códigos de más de 3 dígitos: es el código de concepto que usa facturas (ej. 113014), no el legajo que piden los asientos.`,
      legajo_vacio: `El campo <b>${esc(r.campo)}</b> viene vacío.` }[r.motivo] || 'No se pudo armar el plan.';
    modal(`<h2>No pude armar el plan desde Shares</h2><p>${motivo}</p>
      <p class="small muted">Shares devolvió ${r.total} cuentas con estos campos. Si alguno es el legajo, elegilo y lo intento de nuevo. Si no, mandale esta pantalla a Juan/Claudio o pedile a Shares el plan con legajo en Excel.</p>
      <div class="campo"><label>Campo con el legajo</label><select id="tc-campo">${r.claves.map(k => `<option>${esc(k)}</option>`).join('')}</select></div>
      <details><summary class="small">Cómo vienen las primeras cuentas</summary><pre class="mono small" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(r.ejemplos, null, 2))}</pre></details>
      <div class="acciones" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-cerrar>Cerrar</button><button class="btn btn-negro" id="tc-ok">Usar ese campo</button></div>`, {
      ancho: true,
      alMontar: (m, cerrar) => {
        $('[data-cerrar]', m).onclick = cerrar;
        $('#tc-ok', m).onclick = () => conBoton($('#tc-ok', m), async () => { const c = $('#tc-campo', m).value; cerrar(); await traer(c); });
      },
    });
  };
  $('#b-shares', el).onclick = () => conBoton($('#b-shares', el), () => traer());
  $('#b-imp', el).onclick = () => modal(`<h2>Importar plan de cuentas</h2><p class="muted" style="margin-top:-6px">${esc(nombreEmpresa(cuit))}. Subí el <b>Plan de Cuentas exportado de Shares</b> (PlanCta, .xls) tal cual sale: toma el legajo (LEG) y si recibe asientos (RA). También sirve un Excel propio con columnas <b>Legajo</b> y <b>Denominación</b>.</p>
      <label class="drop" id="pdrop">${ICO.upload}<span>Elegí el Excel</span><input type="file" id="pf" accept=".xlsx,.xls,.csv" hidden></label>
      <label class="check"><input type="checkbox" id="prep"> Reemplazar el plan actual (si no, se agregan y actualizan)</label><div id="pres"></div>`, {
    alMontar: (m, cerrar) => {
      $('#pf', m).onchange = async () => {
        const f = $('#pf', m).files[0]; if (!f) return;
        try {
          const { filas } = await leerFilas(f);
          const reemplazar = $('#prep', m).checked;   // se lee antes: los avisos de confirmación usan la misma ventana
          const rep = parsearPlanShares(filas);
          if (rep) {
            const emp = (S.empresas || []).find(e => e.cuit === cuit) || {};
            const nImp = rep.cuentas.filter(c => c.imputable).length;
            if (!await confirmar(`Plan de cuentas de Shares${rep.empresa ? ` de ${rep.empresa}` : ''}${rep.anio ? ` (ejercicio ${rep.anio})` : ''}:\n${rep.cuentas.length} cuentas, ${nImp} reciben asientos.\n\n¿Cargarlo en ${emp.razon_social || 'esta empresa'}?`, { boton: 'Cargar plan' })) return;
            const x = await api('/api/cuentas/importar', { method: 'POST', body: { cuit_empresa: cuit, filas: rep.cuentas, reemplazar } });
            toast(`✓ ${x.cantidad} cuentas importadas`); await cargar();
            if (rep.anio && Number(emp.periodo_contable) !== rep.anio && await confirmar(`El plan es del ejercicio ${rep.anio} y la empresa tiene cargado ${emp.periodo_contable || 'otro año'}. ¿Actualizar el año del ejercicio a ${rep.anio}?`, { boton: `Sí, ${rep.anio}` })) {
              await api('/api/empresas', { method: 'POST', body: { cuit, razon_social: emp.razon_social, periodo_contable: rep.anio, pdesde: emp.pdesde && String(emp.pdesde).startsWith(String(rep.anio)) ? emp.pdesde : '', phasta: emp.phasta && String(emp.phasta).startsWith(String(rep.anio)) ? emp.phasta : '', activa: emp.activa !== 0 } });
              S.empresas = null; toast(`Año del ejercicio: ${rep.anio}`);
            }
            if (await confirmar('¿Volver a controlar los asientos que todavía no se enviaron con el plan nuevo?', { boton: 'Sí, controlar' })) await recontrolarTodos();
            return;
          }
          let h = -1, cC, cD, cI;
          for (let i = 0; i < Math.min(filas.length, 30) && h < 0; i++) {
            filas[i].forEach((c, j) => { const t = sinAcentos(c); if (/^(legajo|leg\.?)$/.test(t)) cC = j; else if (cC === undefined && /^(codigo|cod\.?|cuenta|n[°ºo]?\s*cuenta)$/.test(t)) cC = j; else if (cD === undefined && /(denominaci|descripci|nombre)/.test(t)) cD = j; else if (cI === undefined && /(imputable|recibe)/.test(t)) cI = j; });
            if (cC !== undefined && cD !== undefined) h = i; else { cC = cD = cI = undefined; }
          }
          if (h < 0) throw new Error('No encontré las columnas Código y Denominación.');
          const rows = filas.slice(h + 1).map(f => ({ codigo: String(f[cC] ?? '').trim(), denominacion: String(f[cD] ?? '').trim(), imputable: cI !== undefined ? f[cI] : undefined })).filter(x => x.codigo && x.denominacion);
          const x = await api('/api/cuentas/importar', { method: 'POST', body: { cuit_empresa: cuit, filas: rows, reemplazar: $('#prep', m).checked } });
          cerrar(); toast(`✓ ${x.cantidad} cuentas importadas`); await cargar();
          if (await confirmar('¿Volver a controlar los asientos que todavía no se enviaron con el plan nuevo?', { boton: 'Sí, controlar' })) await recontrolarTodos();
        } catch (e) { const r = $('#pres', m); if (r) r.innerHTML = `<p class="txt-neg">${esc(e.message)}</p>`; else toast(e.message, true); }
      };
    },
  });
  await cargar();
}

// Reporte "Plan de Cuentas" exportado de Shares (PlanCta.rpt): todo el texto en la columna A, con ancho fijo:
//   LEG  CODIGO                 DENOMINACION              SUMA EN        TC  RA  MO  CI
//   007  ----1.1.1.02.002       BANCO GALICIA CTA. CTE.   1.1.1.02.000   A   SI  SI  5
// LEG es el legajo (lo que piden los asientos) y RA indica si la cuenta recibe asientos.
const RX_PLAN_SHARES = /^\s*(\d{1,3})\s+-*([\d.]+)\s+(.+?)\s{2,}(?:[\d.]+\s+)?[A-Z]{1,2}\s+(SI|NO)\s+(SI|NO)\s+\d+\s*$/;
function parsearPlanShares(filas) {
  const lineas = filas.map(f => String(f[0] ?? ''));
  const cuentas = [];
  for (const l of lineas) {
    const m = l.match(RX_PLAN_SHARES);
    if (m) cuentas.push({ codigo: m[1], denominacion: m[3].trim(), imputable: m[4] === 'SI', codigo_plan: m[2] });
  }
  if (cuentas.length < 5) return null;
  const cab = lineas.find(l => /\s-\s\d{4}\b/.test(l) && !RX_PLAN_SHARES.test(l)) || '';
  const m = cab.match(/^\s*(.+?)\s+-\s+(\d{4})\b/);
  return { cuentas, empresa: m ? m[1].trim() : null, anio: m ? Number(m[2]) : null };
}

async function recontrolarTodos() {
  let desde = 0, total = 0;
  toast('Controlando…');
  for (let i = 0; i < 100; i++) {
    const r = await api('/api/asientos/recontrolar', { method: 'POST', body: { desde_id: desde } });
    total += r.recontrolados; desde = r.siguiente_id;
    if (!r.quedan || !r.recontrolados) break;
  }
  S.cnt = null;
  toast(`✓ ${total} asientos controlados de nuevo`);
}

async function adminUsuarios(el) {
  const aviso = `<div class="panel panel-pad" style="margin-bottom:14px"><h2 style="margin-bottom:6px">Los usuarios se administran desde el portal</h2>
    <p class="muted" style="margin:0 0 12px">Ahí se da acceso a Asientos y se elige el rol de cada persona (carga, aprobador o admin). Vale para todas las herramientas.</p>
    <a class="btn btn-negro" href="${PORTAL}" style="text-decoration:none">Abrir el portal</a></div>`;
  if (!LOGIN_VIEJO) { el.innerHTML = aviso; return; }
  await adminUsuariosViejo(el);
  el.insertAdjacentHTML('afterbegin', aviso + '<h3 style="margin:0 0 10px">Claves anteriores de Asientos (se dejan de usar al terminar la migración)</h3>');
}

async function adminUsuariosViejo(el) {
  const r = await api('/api/usuarios');
  el.innerHTML = `<div class="acciones" style="margin-bottom:12px"><button class="btn btn-negro" id="b-nu">Nuevo usuario</button></div>
    <div class="tabla-wrap"><table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>2FA</th><th>Estado</th><th></th></tr></thead><tbody>
    ${r.usuarios.map(u => `<tr><td>${esc(u.nombre)}</td><td>${esc(u.email)}</td>
      <td><select data-rol="${u.id}">${['carga', 'aprobador', 'admin'].map(x => `<option ${u.rol === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td>${u.totp_activo ? '<span class="badge b-ok">activo</span>' : '<span class="badge b-aviso">no</span>'}</td>
      <td>${u.activo ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      <td class="acciones"><button class="btn btn-chico" data-pass="${u.id}">Resetear clave</button>${u.totp_activo ? `<button class="btn btn-chico" data-totp="${u.id}">Resetear 2FA</button>` : ''}<button class="btn btn-chico" data-act="${u.id}" data-v="${u.activo ? 0 : 1}">${u.activo ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('')}
    </tbody></table></div><p class="small muted">Roles: <b>carga</b> importa, corrige y descarta asientos · <b>aprobador</b> además los envía a Shares, resuelve dudosos y acepta duplicados · <b>admin</b> todo, incluidas empresas, plan de cuentas y configuración.</p>`;
  const put = (id, body) => api('/api/usuarios/' + id, { method: 'PUT', body }).then(() => { toast('Guardado'); adminUsuarios(el); }).catch(e => toast(e.message, true));
  $$('[data-rol]', el).forEach(s => s.onchange = () => put(s.dataset.rol, { rol: s.value }));
  $$('[data-act]', el).forEach(b => b.onclick = () => put(b.dataset.act, { activo: b.dataset.v === '1' }));
  $$('[data-totp]', el).forEach(b => b.onclick = async () => await confirmar('¿Resetear el doble factor de este usuario?') && put(b.dataset.totp, { reset_totp: true }));
  $$('[data-pass]', el).forEach(b => b.onclick = async () => { const p = await pedirTexto({ titulo: 'Nueva contraseña', etiqueta: 'Contraseña (mínimo 10 caracteres)', boton: 'Guardar', minimo: 10 }); if (p) put(b.dataset.pass, { password: p }); });
  $('#b-nu', el).onclick = () => modal(`<h2>Nuevo usuario</h2><form id="f-nu">
      <div class="campo"><label>Nombre</label><input name="nombre" required></div>
      <div class="campo"><label>Email</label><input name="email" type="email" required></div>
      <div class="campo"><label>Rol</label><select name="rol"><option>carga</option><option>aprobador</option><option>admin</option></select></div>
      <div class="campo"><label>Contraseña inicial</label><input name="password" type="text" minlength="10" required><div class="ayuda">Comunicala por un canal seguro; el usuario puede cambiarla desde “Mi cuenta”.</div></div>
      <button class="btn btn-negro" type="submit">Crear</button></form>`, {
    alMontar: (m, cerrar) => { $('#f-nu', m).onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/usuarios', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); cerrar(); toast('Usuario creado'); adminUsuarios(el); }); }; },
  });
}

async function adminConfig(el) {
  const r = await api('/api/config');
  const cfg = r.config;
  el.innerHTML = `<section class="cfg-sec"><h3 class="cfg-h">${ICO.send}Envío a Shares</h3><div class="panel">
      <div class="cfg-row"><div><div class="t">Enviar asientos a Shares</div><div class="d">Apagado: se importan y controlan, pero no se registra nada en Shares. Shares no controla duplicados: lo que se manda, queda.</div></div>
        <div class="cfg-ctrl"><label class="switch"><input type="checkbox" id="sw-env" ${cfg.envio_habilitado ? 'checked' : ''} aria-label="Enviar asientos a Shares"><span></span></label><span class="sw-txt" id="sw-txt">${cfg.envio_habilitado ? 'Activado: “Enviar a Shares” registra de verdad' : 'Apagado'}</span></div></div>
      <div class="cfg-row"><div><div class="t">Tope por envío (modo prueba)</div><div class="d">Cuántos asientos se pueden mandar por vez. Shares recomienda arrancar con 1 y verificarlo en el ERP. Con 0 no hay tope.</div></div>
        <div class="cfg-ctrl"><input type="number" id="tope" value="${esc(cfg.tope_por_envio)}" min="0" step="1" style="width:90px"><span class="muted">asientos</span></div></div>
    </div></section>
    <p class="small muted">Los cambios se guardan automáticamente y quedan en Auditoría.</p>`;
  const guardar = (clave, valor) => api('/api/config', { method: 'PUT', body: { clave, valor } });
  $('#sw-env', el).onchange = async (e) => {
    const c = e.target;
    const msg = c.checked ? '¿Habilitar el envío real a Shares?\n\nDesde ahora “Aprobar y enviar” registra los asientos en el ERP.' : '¿Apagar el envío a Shares? Lo que esté en cola queda esperando.';
    if (!await confirmar(msg)) { c.checked = !c.checked; return; }
    try { await guardar('envio_habilitado', c.checked); $('#sw-txt', el).textContent = c.checked ? 'Activado: “Enviar a Shares” registra de verdad' : 'Apagado'; S.cfg.envio_habilitado = c.checked; toast('Guardado'); }
    catch (err) { c.checked = !c.checked; toast(err.message, true); }
  };
  $('#tope', el).onchange = async (e) => {
    try { const x = await guardar('tope_por_envio', Number(e.target.value)); S.cfg.tope_por_envio = Number(x.config.tope_por_envio) || 0; toast('Guardado'); }
    catch (err) { e.target.value = cfg.tope_por_envio; toast(err.message, true); }
  };
}

async function adminAuditoria(el) {
  const r = await api('/api/auditoria');
  el.innerHTML = `<div class="tabla-wrap tabla-scroll"><table><thead><tr><th>Fecha</th><th>Usuario</th><th>Qué</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>
    ${r.auditoria.map(a => `<tr><td class="mono small">${fmtFH(a.ts)}</td><td class="small">${esc(a.usuario || '')}</td><td class="small">${a.entidad === 'asiento' ? `<a href="#/asiento/${esc(a.entidad_id)}">asiento #${esc(a.entidad_id)}</a>` : a.entidad === 'lote' ? `<a href="#/lote/${esc(a.entidad_id)}">archivo #${esc(a.entidad_id)}</a>` : esc(`${a.entidad} ${a.entidad_id}`)}</td>
      <td class="small">${esc(ACCIONES_AUD[a.accion] || a.accion)}</td><td class="small muted" style="max-width:420px;overflow-wrap:anywhere">${esc(String(a.valor_nuevo || '').slice(0, 200))}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------------------------------------------------------------------------
//  Mi cuenta: contraseña y doble factor
// ---------------------------------------------------------------------------
async function vistaMiCuenta(el) {
  if (S.user.central) {
    el.innerHTML = `<div class="encabezado"><div><h1>Mi cuenta</h1><p>${esc(S.user.email)} · rol ${esc(S.user.rol)}</p></div></div>
      ${bloqueInstalar()}
      <div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:12px">Usuario y contraseña</h2>
        <p class="muted">Usás el mismo usuario en todas las herramientas de Lucciano's. La contraseña y los permisos se manejan desde el portal.</p>
        <a class="btn btn-negro" href="${PORTAL}" style="text-decoration:none">Ir al portal</a></div>`;
    montarInstalar(el);
    return;
  }
  el.innerHTML = `<div class="encabezado"><div><h1>Mi cuenta</h1><p>${esc(S.user.email)} · rol ${esc(S.user.rol)}</p></div></div>
    ${bloqueInstalar()}
    <div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:12px">Doble factor</h2>
      ${S.user.totp_activo ? '<p><span class="badge b-ok">Activo</span> Al ingresar se solicitará el código de tu aplicación autenticadora.</p>'
      : '<p class="muted">Usá Google Authenticator, Microsoft Authenticator o similar.</p><button class="btn btn-negro" id="b-2fa">Activar doble factor</button><div id="c-2fa"></div>'}
    </div>
    <form class="panel panel-pad" style="max-width:560px" id="f-pass"><h2 style="margin-bottom:12px">Cambiar contraseña</h2>
      <div class="campo"><label>Actual</label><input type="password" name="actual" required autocomplete="current-password"></div>
      <div class="campo"><label>Nueva (mínimo 10 caracteres)</label><input type="password" name="nueva" minlength="10" required autocomplete="new-password"></div>
      <button class="btn btn-negro" type="submit">Cambiar</button></form>`;
  $('#f-pass').onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/yo/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Contraseña cambiada'); }); };
  montarInstalar(el);
  const b = $('#b-2fa');
  if (b) b.onclick = () => conBoton(b, async () => {
    const r = await api('/api/yo/totp/iniciar', { method: 'POST' });
    $('#c-2fa').innerHTML = `<p>1. Escaneá este QR con la app:</p><div id="qr" style="background:#fff;padding:12px;display:inline-block;border-radius:8px"></div>
      <p class="small muted">o ingresá la clave manualmente: <span class="mono">${esc(r.secret)}</span></p>
      <p>2. Escribí el código de 6 dígitos que muestra la app:</p><div class="fila"><input id="code" inputmode="numeric" maxlength="6" class="mono"><button class="btn btn-negro" id="b-conf">Confirmar</button></div>`;
    if (window.QRCode) new QRCode($('#qr'), { text: r.otpauth, width: 180, height: 180 });
    else $('#qr').textContent = r.otpauth;
    b.remove();
    $('#b-conf').onclick = () => conBoton($('#b-conf'), async () => { await api('/api/yo/totp/confirmar', { method: 'POST', body: { code: $('#code').value } }); S.user.totp_activo = true; toast('Doble factor activado'); vistaMiCuenta(el); });
  });
}

// ---------------------------------------------------------------------------
//  Guía de uso + bienvenida la primera vez (como en facturas)
// ---------------------------------------------------------------------------
const PASOS_GUIA = [
  ['upload', 'Subís el Excel', 'El mismo Excel de movimientos bancarios, con todas sus hojas. La app arma un asiento por cada bloque (Fecha, renglones, Totales y observación) y deja afuera los modelos vacíos y los marcados “ok - pasado”, que ya se cargaron a mano.'],
  ['shield', 'Controles', 'Antes de guardar, cada asiento se controla: que balancee al centavo, que las cuentas existan y reciban asientos, que la fecha esté dentro del ejercicio y que no esté repetido.'],
  ['inbox', 'Corregís lo observado', 'Los que tienen errores quedan “Con errores”, con el motivo. Se corrigen en la app (cuentas, importes, fecha, observación) o en el Excel, y se vuelven a controlar.'],
  ['send', 'Aprobás y se envía', 'Un aprobador elige los asientos en “Enviar a Shares”. Se mandan de a uno, en orden de fecha, en segundo plano: podés cerrar la pestaña.'],
  ['check', 'Shares devuelve el número', 'Cada asiento cargado queda con su número de Shares. Desde “Archivos subidos” se descarga el Excel con el resultado de cada uno.'],
];
const GUIA_ESTADOS = [
  ['pendiente', 'Pasó todos los controles y se puede enviar.'],
  ['observado', 'Tiene algún error (no balancea, cuenta que no existe, fecha fuera del ejercicio…). Se corrige y se vuelve a controlar.'],
  ['en_cola', 'Aprobado: espera su turno para salir hacia Shares.'],
  ['enviando', 'Saliendo hacia Shares en este momento.'],
  ['cargado', 'Registrado en Shares, con su número de asiento.'],
  ['error', 'Shares lo rechazó con un motivo (por ejemplo, período cerrado). No quedó registrado: se corrige y se reenvía.'],
  ['dudoso', 'Salió hacia Shares y no llegó la respuesta. Puede haber quedado registrado: hay que buscarlo en el ERP y marcar si está o no. Ese asiento no se reenvía solo; los demás siguen saliendo.'],
  ['descartado', 'No se va a enviar. Queda en el historial y se puede reabrir.'],
];
async function vistaGuia(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Guía de uso</h1><p>Cómo funciona la carga de asientos, qué significa cada estado y qué hacer si algo sale mal.</p></div>
    <div class="acciones"><button class="btn" id="b-bienv">${ICO.sparkle}Ver la bienvenida otra vez</button></div></div>
    <div class="panel"><div class="panel-titulo"><h2>El recorrido de un asiento</h2></div>
      <ol class="pasos-guia">${PASOS_GUIA.map(([ic, t, d], i) => `<li><span class="num-paso">${ICO[ic]}<b>${i + 1}</b></span><div><div class="t">${esc(t)}</div><p>${esc(d)}</p></div></li>`).join('')}</ol></div>
    <div class="dos" style="margin-top:16px">
      <div class="panel"><div class="panel-titulo"><h2>El Excel</h2></div><div class="panel-pad guia-txt">
        <p><b>Formato:</b> un bloque por asiento. Fila “Fecha:” con la fecha al lado, títulos, renglones (A cuenta, B detalle, C debe, D haber), “Totales” y abajo la observación. Los títulos sueltos (BANCO GALICIA, PAGO GASTOS…) se usan para mostrar de dónde sale cada asiento. Si tenés dudas, en “Importar Excel” podés descargar un modelo.</p>
        <p><b>Cuenta:</b> el legajo de Shares (7 Banco Galicia, 9 Banco Francés…), no el código del plan (1.1.1.02.002).</p>
        <p><b>Marca “ok - pasado”</b> en la columna E: el asiento ya se cargó a mano y no se importa. Para que la app lo envíe, no tiene que tener la marca.</p>
        <p><b>Bloques en cero o sin fecha:</b> se ignoran (son los modelos para el mes siguiente). Los renglones en cero dentro de un asiento con importes se sacan.</p>
        <p><b>Observaciones:</b> Shares guarda hasta 70 caracteres. Si son más largas, la app avisa.</p></div></div>
      <div class="panel"><div class="panel-titulo"><h2>Si algo sale mal</h2></div><div class="panel-pad guia-txt">
        <p><b>Rechazado por Shares:</b> entrá al asiento y vas a ver el mensaje de Shares. No quedó registrado: corregilo y volvé a enviarlo. Si el rechazo es por el año del ejercicio, la app lo corrige sola y lo reenvía.</p>
        <p><b>Dudoso:</b> buscalo en Shares (empresa, fecha, importe y observación figuran en el asiento). Si está, marcá “Sí, está” y anotá el número; si no, “No está” y vuelve a “Para enviar”. Nunca lo marques “No está” sin buscarlo: Shares no controla duplicados.</p>
        <p><b>Repetido:</b> si un asiento es igual a otro (misma fecha, cuentas, importes y observación), queda frenado. Si de verdad va dos veces, un aprobador acepta el duplicado con un comentario.</p>
        <p><b>Error en el Excel:</b> si el asiento todavía no se envió, corregilo en la app o descartalo y volvé a subir el Excel corregido.</p>
        <h3 style="margin:18px 0 8px">Atajos</h3>
        <dl class="kv atajos"><dt><kbd>Ctrl</kbd> <kbd>K</kbd></dt><dd>Buscar desde cualquier pantalla: asiento, observación, cuenta o N° de Shares.</dd><dt><kbd>Esc</kbd></dt><dd>Cerrar una ventana.</dd></dl></div></div>
    </div>
    <div class="panel"><div class="panel-titulo"><h2>Qué significa cada estado</h2></div><div class="panel-pad">
      <dl class="kv">${GUIA_ESTADOS.map(([e, d]) => `<dt style="font-family:var(--sans)">${badgeEstado(e)}</dt><dd style="font-family:var(--sans)">${esc(d)}</dd>`).join('')}</dl>
      <p class="small muted" style="margin:14px 0 0">Roles: <b>carga</b> importa, corrige y descarta · <b>aprobador</b> además envía a Shares, resuelve dudosos y acepta duplicados · <b>admin</b> todo, incluida la configuración.</p></div></div>`;
  $('#b-bienv').onclick = () => bienvenida(true);
}
function bienvenida(forzar = false) {
  try { if (!forzar && localStorage.getItem('asientos_bienvenida')) return; localStorage.setItem('asientos_bienvenida', '1'); } catch { if (!forzar) return; }
  let i = 0;
  const pintar = (el, cerrar) => {
    const [ic, t, d] = PASOS_GUIA[i];
    el.innerHTML = `<div class="bienv"><span class="bienv-ico">${ICO[ic]}</span><span class="et">Paso ${i + 1} de ${PASOS_GUIA.length}</span><h2>${esc(t)}</h2><p class="muted">${esc(d)}</p>
      <div class="puntos">${PASOS_GUIA.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="acciones" style="justify-content:space-between;width:100%"><button class="btn btn-ghost" id="bv-salt">${i === PASOS_GUIA.length - 1 ? '' : 'Saltar'}</button>
        <span class="acciones">${i ? `<button class="btn" id="bv-ant">${ICO.back}Atrás</button>` : ''}<button class="btn btn-acento" id="bv-sig">${i === PASOS_GUIA.length - 1 ? 'Empezar' : 'Siguiente'} ${ICO.arrow}</button></span></div></div>`;
    $('#bv-sig', el).onclick = () => { if (i === PASOS_GUIA.length - 1) return cerrar(); i++; pintar(el, cerrar); };
    const a = $('#bv-ant', el); if (a) a.onclick = () => { i--; pintar(el, cerrar); };
    $('#bv-salt', el).onclick = cerrar;
  };
  modal('<div></div>', { alMontar: (el, cerrar) => pintar(el, cerrar) });
}
