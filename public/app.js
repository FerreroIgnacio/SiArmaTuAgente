const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const form = $('#form');

let botId = null;
let bots = [];
let timerGuardado = null;
let guardando = Promise.resolve();
let eventos = null;
let sesionPrueba = nuevaSesion();
let estadoPrueba = null; // estado donde está la charla de prueba, se resalta en el lienzo

function nuevaSesion() { return Math.random().toString(36).slice(2); }
const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : nuevaSesion() + Date.now().toString(36));
function leer(k) { try { return localStorage.getItem(k); } catch { return null; } }
function guardarLocal(k, v) { try { localStorage.setItem(k, v); } catch {} }

async function api(metodo, url, body) {
  const res = await fetch(url, {
    method: metodo,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Sesión vencida'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function el(tag, props = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...hijos.filter(h => h != null));
  return e;
}

/* ---------- Form <-> objeto ---------- */
function setPath(obj, ruta, valor) {
  const partes = ruta.split('.');
  let o = obj;
  partes.slice(0, -1).forEach(p => (o = o[p] ??= {}));
  o[partes.at(-1)] = valor;
}
const getPath = (obj, ruta) => ruta.split('.').reduce((o, p) => o?.[p], obj);

function leerForm() {
  const datos = {};
  for (const e of form.querySelectorAll('[name]')) {
    if (e.closest('fieldset:disabled')) continue;
    if (e.type === 'radio') { if (e.checked) setPath(datos, e.name, e.value); }
    else if (e.type === 'checkbox') setPath(datos, e.name, e.checked);
    else setPath(datos, e.name, e.value.trim());
  }
  datos.flujo = { nodos };
  return datos;
}

function llenarForm(bot) {
  cargarFlujo(bot.flujo);
  for (const e of form.querySelectorAll('[name]')) {
    const v = getPath(bot, e.name);
    if (e.type === 'radio') e.checked = v === e.value;
    else if (e.type === 'checkbox') e.checked = !!v;
    else e.value = v ?? '';
  }
  $('#webhookUrl').value = `${location.origin}/webhooks/meta/${bot.id}`;
  refrescarDerivados();
  revisarLLM();
}

/* ---------- Autoguardado ---------- */
function cambio() {
  $('#saved').textContent = 'Sin guardar';
  refrescarDerivados();
  clearTimeout(timerGuardado);
  timerGuardado = setTimeout(guardar, 600);
}

function guardar() {
  clearTimeout(timerGuardado);
  timerGuardado = null;
  if (!botId) return guardando;
  const id = botId, datos = leerForm();
  guardando = guardando.then(async () => {
    try {
      await api('PUT', `/api/bots/${id}`, datos);
      if (id === botId) $('#saved').textContent = 'Guardado';
      const b = bots.find(b => b.id === id);
      if (b) { b.nombre = datos.agente.nombre; }
    } catch (err) {
      $('#saved').textContent = `No se guardó: ${err.message}`;
    }
  });
  return guardando;
}

const guardarPendiente = () => (timerGuardado ? guardar() : guardando);

form.addEventListener('input', e => { if (e.target.name) cambio(); });
form.addEventListener('change', e => {
  if (e.target.name && (e.target.type === 'radio' || e.target.type === 'checkbox' || e.target.tagName === 'SELECT')) cambio();
  if (e.target.name === 'agente.usarLLM') revisarLLM();
});
form.addEventListener('submit', e => e.preventDefault());

const URL_GUIA_META = '/ayuda/api-meta';

function refrescarDerivados() {
  const prov = form.querySelector('[name="conexion.proveedor"]:checked')?.value;
  $('#metaFields').hidden = prov !== 'meta';
  $('#provHelp').replaceChildren(
    prov === 'baileys' ? 'Se vincula como WhatsApp Web escaneando un QR. Usa el número que ya tenés. ' : '',
    'Solo para probar, para no violar los términos y condiciones de WhatsApp. Para tráfico real necesitás una API de Meta, ',
    el('a', { href: URL_GUIA_META, target: '_blank', rel: 'noopener' }, 'Como conseguir una api de meta'), '.');

  const nombre = form.elements['agente.nombre'].value.trim() || 'Asistente';
  $('#tName').textContent = nombre;
  $('#tAvatar').textContent = nombre[0].toUpperCase();
}

async function revisarLLM() {
  const p = $('#llmEstado');
  // El LLM todavía no está disponible en el servidor: la opción queda deshabilitada y apagada
  form.elements['agente.usarLLM'].checked = false;
  if (!form.elements['agente.usarLLM'].checked) { p.hidden = true; return; }
  p.hidden = false;
  p.className = 'help indent llm-estado';
  p.textContent = 'Revisando conexión…';
  const s = await api('GET', '/api/llm').catch(err => ({ ok: false, detalle: err.message }));
  p.classList.toggle('ok', !!s.ok);
  p.textContent = s.ok ? `Conectado a ${s.url} · modelo ${s.modelo}` : s.detalle;
}

/* ---------- Respuestas (grafo) ---------- */
const TIPOS = {
  texto: 'Texto',
  imagen: 'Imagen',
  documento: 'Documento',
  ubicacion: 'Ubicación',
  contacto: 'Contacto',
};

// Máquina de estados: cada nodo es un estado que manda sus mensajes y escucha respuestas.
// Cada salida { id, texto, disparadores, destino } es una respuesta que escucha y el estado al que lleva.
let nodos = [];
let seleccionado = null;
const marcados = new Set(); // estados sumados a la selección con shift+clic, para moverlos juntos
const enSeleccion = id => id === seleccionado || marcados.has(id);

const nodo = id => nodos.find(n => n.id === id);
const destinosDe = n => [...new Set((n.salidas || []).map(s => nodo(s.destino)).filter(Boolean))];
const padresDe = n => nodos.filter(p => p.salidas?.some(s => s.destino === n.id));
const nombreDe = n => n.id === 'inicio' ? 'Inicio' : n.nombre || 'Sin nombre';

// Camino más corto desde el inicio a cada estado alcanzable: Map id → [inicio, ..., nodo]
function caminos() {
  const out = new Map();
  const inicio = nodo('inicio');
  if (!inicio) return out;
  out.set('inicio', [inicio]);
  const cola = [inicio];
  while (cola.length) {
    const n = cola.shift();
    for (const h of destinosDe(n)) {
      if (out.has(h.id)) continue;
      out.set(h.id, [...out.get(n.id), h]);
      cola.push(h);
    }
  }
  return out;
}

// Igual que en el motor: sin mayúsculas, tildes ni signos
const normalizar = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim();

// Respuestas de un estado que escuchan lo mismo que otra (por texto o por sus otras formas): Map id → frase repetida
function repetidas(n) {
  const duenos = new Map();
  for (const s of n.salidas || []) {
    for (const frase of new Set([s.texto, ...String(s.disparadores || '').split(',')].map(normalizar).filter(Boolean))) {
      duenos.set(frase, [...(duenos.get(frase) || []), s.id]);
    }
  }
  const out = new Map();
  for (const [frase, ids] of duenos) if (ids.length > 1) ids.forEach(id => out.has(id) || out.set(id, frase));
  return out;
}

const rutaDe = id => {
  if (!nodo(id)) return '—';
  const c = caminos().get(id);
  if (!c) return 'Desconectada';
  return c.map(nombreDe).join(' › ');
};

function editado() {
  cambio();
  renderArbol();
}

function campo(etiqueta, r, clave, { tipo = 'input', ayuda, ...attrs } = {}) {
  const input = el(tipo === 'textarea' ? 'textarea' : 'input', { value: r[clave] ?? '', ...attrs });
  input.addEventListener('input', () => { r[clave] = input.value; editado(); });
  return el('label', {}, etiqueta, input, ayuda ? el('small', {}, ayuda) : null);
}

function subida(r, { accept, etiqueta }) {
  const file = el('input', { type: 'file', accept });
  const url = el('input', { value: r.url || '', placeholder: 'o pegá una URL https://…' });
  const btn = el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => file.click() }, etiqueta);
  url.addEventListener('input', () => { r.url = url.value.trim(); editado(); });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    btn.disabled = true;
    btn.textContent = 'Subiendo…';
    try {
      const res = await fetch(`/api/bots/${botId}/archivos`, { method: 'POST', headers: { 'x-nombre': encodeURIComponent(f.name) }, body: f });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      r.url = data.url;
      if (r.tipo === 'documento' && !r.nombreArchivo) r.nombreArchivo = f.name;
      editado();
      renderDetalle();
    } catch (err) {
      btn.textContent = `Error: ${err.message}`;
      btn.disabled = false;
    }
  });
  return el('div', { class: 'upload' }, btn, url, file);
}

function contenido(r) {
  switch (r.tipo) {
    case 'imagen':
      return [
        el('label', {}, 'Imagen', subida(r, { accept: 'image/*', etiqueta: 'Subir imagen' })),
        r.url ? el('img', { class: 'preview-img', src: r.url, alt: '' }) : null,
        campo('Texto debajo de la imagen', r, 'texto', { tipo: 'textarea', rows: 2 }),
      ];
    case 'documento':
      return [
        el('label', {}, 'Archivo', subida(r, { accept: '', etiqueta: 'Subir archivo' })),
        campo('Nombre con el que llega', r, 'nombreArchivo', { placeholder: 'Lista de precios.pdf' }),
        campo('Mensaje', r, 'texto', { tipo: 'textarea', rows: 2 }),
      ];
    case 'ubicacion':
      return [
        el('div', { class: 'row2' }, campo('Nombre del lugar', r, 'nombre'), campo('Dirección', r, 'direccion')),
        el('div', { class: 'row2' },
          campo('Latitud', r, 'lat', { placeholder: '-34.7012', inputMode: 'decimal' }),
          campo('Longitud', r, 'lng', { placeholder: '-58.3920', inputMode: 'decimal' })),
        el('small', { class: 'help' }, 'En Google Maps: clic derecho sobre el lugar y copiá los números.'),
      ];
    case 'contacto':
      return [
        el('div', { class: 'row2' }, campo('Nombre', r, 'nombre', { placeholder: 'Ventas' }), campo('Teléfono', r, 'telefono', { placeholder: '+54 9 11 2345-6789', inputMode: 'tel' })),
      ];
    default:
      return [campo('Mensaje', r, 'texto', { tipo: 'textarea', rows: 4 })];
  }
}


/* ---------- Lienzo ---------- */
const GRID = 20, NODO_W = 220, CAB_H = 56, SAL_H = 30, COL = 300, SEP = 40;
const vista = { x: 40, y: 40, z: 1 };
let ajustarAlMostrar = true;
const snap = v => Math.round(v / GRID) * GRID;
const terminal = n => n.tipo === 'accion' || n.tipo === 'salto';
const filasDe = n => (terminal(n) ? [] : n.salidas) || [];
const altoNodo = n => CAB_H + filasDe(n).length * SAL_H;

// Ubica en columnas por profundidad; las hojas se apilan y el padre queda centrado en sus destinos.
// Un estado al que se llega desde varios se ubica una sola vez; los desconectados van abajo.
function ordenar() {
  let y = 0;
  const vistos = new Set();
  const ubicar = (n, prof) => {
    vistos.add(n.id);
    const hijos = destinosDe(n).filter(h => !vistos.has(h.id));
    hijos.forEach(h => vistos.add(h.id));
    if (hijos.length) {
      hijos.forEach(h => ubicar(h, prof + 1));
      n.pos = { x: prof * COL, y: snap((hijos[0].pos.y + hijos.at(-1).pos.y) / 2) };
    } else {
      n.pos = { x: prof * COL, y: snap(y) };
    }
    y = Math.max(y, n.pos.y + altoNodo(n) + SEP);
  };
  if (nodo('inicio')) ubicar(nodo('inicio'), 0);
  for (const n of nodos) if (!vistos.has(n.id)) ubicar(n, 0);
}

// Estados nuevos o sin posición: al lado del que lleva a ellos, debajo de sus otros destinos
function posicionLibre(padre, nuevo) {
  const otros = destinosDe(padre).filter(h => h !== nuevo && h.pos);
  const y = otros.length ? Math.max(...otros.map(h => h.pos.y + altoNodo(h))) + SEP : padre.pos.y;
  return { x: padre.pos.x + COL, y: snap(y) };
}

function completarPosiciones() {
  for (const n of nodos) {
    if (n.pos) continue;
    const padre = padresDe(n).find(p => p.pos);
    n.pos = padre ? posicionLibre(padre, n) : centroVista();
  }
}

// Punto del lienzo que está en el centro de lo visible (sin el panel de edición)
function centroVista() {
  const flow = $('#flow');
  const ancho = flow.clientWidth - ($('#nodoEditor').hidden ? 0 : 360);
  return { x: snap((ancho / 2 - vista.x) / vista.z - NODO_W / 2), y: snap((flow.clientHeight / 2 - vista.y) / vista.z - CAB_H / 2) };
}

function aplicarVista() {
  $('#flowWorld').style.transform = `translate(${vista.x}px, ${vista.y}px) scale(${vista.z})`;
  const flow = $('#flow');
  flow.style.backgroundSize = `${GRID * vista.z}px ${GRID * vista.z}px`;
  flow.style.backgroundPosition = `${vista.x}px ${vista.y}px`;
  $('#zoomPct').textContent = `${Math.round(vista.z * 100)}%`;
}

function zoom(factor, cx, cy) {
  const flow = $('#flow').getBoundingClientRect();
  cx ??= flow.width / 2; cy ??= flow.height / 2;
  const z = Math.min(2, Math.max(0.3, vista.z * factor));
  vista.x = cx - ((cx - vista.x) * z) / vista.z;
  vista.y = cy - ((cy - vista.y) * z) / vista.z;
  vista.z = z;
  aplicarVista();
}


function ajustar() {
  const flow = $('#flow').getBoundingClientRect();
  if (!flow.width || !nodos.length) { ajustarAlMostrar = true; return; }
  ajustarAlMostrar = false;
  const minX = Math.min(...nodos.map(n => n.pos.x)), maxX = Math.max(...nodos.map(n => n.pos.x)) + NODO_W;
  const minY = Math.min(...nodos.map(n => n.pos.y)), maxY = Math.max(...nodos.map(n => n.pos.y + altoNodo(n)));
  const libreDer = $('#nodoEditor').hidden ? 0 : 360;
  const w = flow.width - libreDer - 80, h = flow.height - 100;
  vista.z = Math.min(2, Math.max(0.3, Math.min(w / (maxX - minX), h / (maxY - minY))));
  vista.x = 40 + (w - (maxX - minX) * vista.z) / 2 - minX * vista.z;
  vista.y = 40 + (h - (maxY - minY) * vista.z) / 2 - minY * vista.z;
  aplicarVista();
}

// Conector ortogonal con esquinas redondeadas, de un punto de salida a un punto de entrada
function conector({ x: x1, y: y1 }, { x: x2, y: y2 }) {
  if (x2 - x1 < 40) {
    const d = Math.max(60, Math.abs(x2 - x1) / 2);
    return `M${x1} ${y1} C${x1 + d} ${y1} ${x2 - d} ${y2} ${x2} ${y2}`;
  }
  const mx = x1 + Math.min(40, (x2 - x1) / 2);
  const dy = y2 - y1, r = Math.min(10, Math.abs(dy) / 2), s = Math.sign(dy);
  if (!r) return `M${x1} ${y1} H${x2}`;
  return `M${x1} ${y1} H${mx - r} Q${mx} ${y1} ${mx} ${y1 + s * r} V${y2 - s * r} Q${mx} ${y2} ${mx + r} ${y2} H${x2}`;
}

const svg = (tag, attrs = {}) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

// Centro de un puerto en coordenadas del lienzo. Se mide en el DOM porque los estados tienen alto variable;
// si el lienzo está oculto se usa la posición calculada.
function puntoDe(n, sel, estimado) {
  const p = $(`.fnode[data-id="${n.id}"]`)?.querySelector(sel);
  if (!p?.offsetParent) return estimado;
  let x = p.offsetWidth / 2, y = p.offsetHeight / 2, e = p;
  while (e && !e.classList.contains('fnode')) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
  return { x: n.pos.x + x + (e?.clientLeft || 0), y: n.pos.y + y + (e?.clientTop || 0) };
}
const puntoSalida = (n, s) => puntoDe(n, `.port.out[data-salida="${s.id}"]`,
  { x: n.pos.x + NODO_W, y: n.pos.y + CAB_H + n.salidas.indexOf(s) * SAL_H + SAL_H / 2 });
const puntoEntrada = n => puntoDe(n, '.port.in', { x: n.pos.x, y: n.pos.y + CAB_H / 2 });

// Cada conexión: la línea visible + una más gruesa e invisible para poder hacerle clic
function dibujarConectores() {
  const lineas = [];
  for (const n of nodos) {
    for (const s of n.salidas || []) {
      const h = nodo(s.destino);
      if (!h) continue;
      const d = conector(puntoSalida(n, s), puntoEntrada(h));
      const g = svg('g', { 'data-padre': n.id, 'data-salida': s.id });
      const on = seleccionado && (n.id === seleccionado || h.id === seleccionado);
      g.append(svg('path', { d, class: on ? 'on' : '' }), svg('path', { d, class: 'hit' }));
      g.lastChild.append(svg('title'));
      g.lastChild.firstChild.textContent = 'Clic para desconectar';
      lineas.push(g);
    }
  }
  $('#flowEdges').replaceChildren(...lineas);
}

function rehacerTodo() {
  cambio();
  renderArbol();
  if (seleccionado) renderDetalle();
}

function desconectar(padreId, salidaId) {
  const s = nodo(padreId)?.salidas?.find(x => x.id === salidaId);
  if (!s) return;
  s.destino = null;
  rehacerTodo();
}

const nuevaSalida = (destino = null) => ({ id: nuevoId(), texto: '', disparadores: '', destino });

// Conecta una salida de `origen` con el estado `destino`. Sin salida, agrega una nueva.
function conectar(origen, salidaId, destino) {
  const s = salidaId && origen.salidas?.find(x => x.id === salidaId);
  if (s) s.destino = destino.id;
  else (origen.salidas ??= []).push(nuevaSalida(destino.id));
  rehacerTodo();
}

function resumenNodo(n) {
  if (n.tipo === 'accion') return n.accion ? resumenAccion(n.accion) : 'Elegí qué hace';
  if (n.tipo === 'salto') return n.objetivo ? `Va a ${n.objetivo}` : 'Elegí a qué estado va';
  const mensajes = n.mensajes || [];
  if (!mensajes.length) return 'Sin mensajes';
  return resumenMensaje(mensajes[0]) + (mensajes.length > 1 ? ` · +${mensajes.length - 1}` : '');
}

function resumenAccion(a) {
  switch (a.tipo) {
    case 'mail': return `Mail a ${a.para || '…'}`;
    case 'whatsapp': return `WhatsApp a ${a.numero || '…'}`;
    case 'sheets': return a.modo === 'actualizar' ? 'Actualizar fila en Sheets' : 'Agregar fila en Sheets';
    default: return 'Acción';
  }
}

function resumenMensaje(n) {
  switch (n.tipo) {
    case 'imagen': return n.url ? 'Imagen' : 'Imagen sin archivo';
    case 'documento': return n.nombreArchivo || 'Documento';
    case 'ubicacion': return n.nombre || n.direccion || 'Ubicación';
    case 'contacto': return n.nombre || n.telefono || 'Contacto';
    default: return n.texto?.split('\n')[0] || 'Sin mensaje';
  }
}


const ICONO_TACHO = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
const ICONO_OK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
let confirmarTacho = null; // id del estado cuyo tachito espera el segundo clic

function renderArbol() {
  completarPosiciones();
  const rutas = caminos();
  const divs = nodos.map(n => {
    const esRaiz = n.id === 'inicio';
    const esAccion = n.tipo === 'accion', esSalto = n.tipo === 'salto';
    const salidas = terminal(n) ? [] : n.salidas || [];
    const dups = repetidas(n);
    const div = el('div', { class: `fnode${esAccion ? ' accion' : esSalto ? ' salto' : ''}${n.id === estadoPrueba ? ' actual' : ''}${dups.size ? ' con-error' : ''}${rutas.has(n.id) ? '' : ' suelto'}${n.id === seleccionado ? ' sel' : marcados.has(n.id) ? ' marcado' : ''}` },
      el('div', { class: 'fhead' },
        esRaiz ? el('span', { class: 'num' }, '★') : el('span', { class: 'port in', title: 'Soltá acá una salida para conectar' }),
        esAccion ? el('span', { class: 'num' }, '⚙') : esSalto ? el('span', { class: 'num' }, '↪') : null,
        el('span', { class: 'txt' },
          el('b', { class: !esRaiz && !n.nombre ? 'vacio' : '' }, nombreDe(n)),
          el('small', {}, resumenNodo(n))),
        terminal(n) || salidas.length > 1 ? null : el('span', { class: 'port out nueva', title: 'Arrastrá hasta un estado para agregar una respuesta' })),
      salidas.length ? el('ul', { class: 'fsal' }, ...salidas.map(s => el('li', {
        class: `${nodo(s.destino) ? '' : 'libre'}${dups.has(s.id) ? ' dup' : ''}`, 'data-salida': s.id,
        title: dups.has(s.id) ? `Repetida: otra respuesta también escucha "${dups.get(s.id)}"` : '' },
        s.cualquiera
          ? el('span', { class: 'cualquiera' }, `✱ Cualquier respuesta${n.guardarEn ? ` → {${n.guardarEn}}` : ''}`)
          : el('span', { class: s.texto ? '' : 'vacio' }, s.texto || 'Sin texto'),
        el('span', { class: 'port out', 'data-salida': s.id, title: 'Arrastrá hasta un estado para conectar' })))) : null);
    div.style.left = `${n.pos.x}px`;
    div.style.top = `${n.pos.y}px`;
    div.dataset.id = n.id;
    if (n.id === seleccionado) {
      const confirmando = confirmarTacho === n.id;
      const filas = filasDe(n).length;
      const quitar = confirmando ? 'Confirmar'
        : filas ? 'Quitar la última respuesta' : (esAccion ? 'Eliminar acción' : esSalto ? 'Eliminar salto' : 'Eliminar estado');
      const tacho = el('button', { type: 'button', class: `add del${confirmando ? ' confirmar' : ''}${terminal(n) ? ' solo' : ''}`, title: quitar, 'aria-label': quitar, onclick: () => quitarUltima(n) });
      if (esRaiz && !filas) tacho.disabled = true;
      tacho.innerHTML = confirmando ? ICONO_OK : ICONO_TACHO;
      div.append(tacho);
      // Un nodo de acción es terminal: no tiene respuestas para agregar
      if (!terminal(n)) div.append(el('button', { type: 'button', class: 'add', title: 'Agregar respuesta', 'aria-label': 'Agregar respuesta', onclick: () => agregarSalida(n) }, '+'));
    }
    return div;
  });
  $('#flowNodes').replaceChildren(...divs);
  dibujarConectores();
  $('#respCount').textContent = nodos.length - 1 || '';
}

/* Arrastre de estados, conexiones y paneo del lienzo */
(() => {
  const flow = $('#flow');
  let gesto = null;

  flow.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.nodo-card, .flow-tools, .add, input')) return;
    const nodoEl = e.target.closest('.fnode');
    const port = e.target.closest('.port');
    flow.setPointerCapture(e.pointerId);
    if (port) {
      const temp = svg('path', { class: 'temp' });
      $('#flowEdges').append(temp);
      const n = nodo(nodoEl.dataset.id);
      const desdeSalida = port.classList.contains('out');
      const s = n.salidas?.find(x => x.id === port.dataset.salida);
      const desde = !desdeSalida ? puntoEntrada(n)
        : s ? puntoSalida(n, s) : puntoDe(n, '.port.out.nueva', { x: n.pos.x + NODO_W, y: n.pos.y + CAB_H / 2 });
      gesto = { tipo: 'conectar', nodo: n, salida: s?.id || null, desdeSalida, desde, temp };
      flow.classList.add('conectando');
      moverConexion(e);
    } else if (nodoEl) {
      const n = nodo(nodoEl.dataset.id);
      // Si el estado es parte de la selección se mueven todos los seleccionados
      const grupo = (enSeleccion(n.id) ? nodos.filter(x => enSeleccion(x.id)) : [n])
        .map(x => ({ n: x, el: $(`.fnode[data-id="${x.id}"]`), px: x.pos.x, py: x.pos.y }));
      gesto = { tipo: 'nodo', nodo: n, grupo, x0: e.clientX, y0: e.clientY, movido: false, shift: e.shiftKey,
        salida: e.target.closest('.fsal li')?.dataset.salida, nombre: !!e.target.closest('.fhead b') };
    } else {
      gesto = { tipo: 'pan', x0: e.clientX, y0: e.clientY, vx: vista.x, vy: vista.y, movido: false, linea: e.target.closest('.flow-edges g')?.dataset };
      flow.classList.add('panning');
    }
  });

  const aMundo = e => {
    const r = flow.getBoundingClientRect();
    return { x: (e.clientX - r.left - vista.x) / vista.z, y: (e.clientY - r.top - vista.y) / vista.z };
  };
  // Estado bajo el puntero con el que se conecta el gesto actual
  const destinoDe = e => {
    const bajo = document.elementFromPoint(e.clientX, e.clientY);
    const id = bajo?.closest('.fnode')?.dataset.id;
    const otro = id && nodo(id);
    if (!otro || otro === gesto.nodo) return null;
    if ((gesto.desdeSalida ? otro : gesto.nodo).id === 'inicio') return null;
    if (terminal(gesto.desdeSalida ? gesto.nodo : otro)) return null;
    if (gesto.desdeSalida) return { origen: gesto.nodo, destino: otro };
    // Soltado sobre una respuesta concreta: se reconecta esa en vez de agregar una nueva
    const salida = bajo.closest('[data-salida]')?.dataset.salida || null;
    return { origen: otro, destino: gesto.nodo, salida };
  };

  function moverConexion(e) {
    const p = aMundo(e), q = gesto.desde;
    const d = gesto.desdeSalida
      ? `M${q.x} ${q.y} C${q.x + 60} ${q.y} ${p.x - 60} ${p.y} ${p.x} ${p.y}`
      : `M${p.x} ${p.y} C${p.x + 60} ${p.y} ${q.x - 60} ${q.y} ${q.x} ${q.y}`;
    gesto.temp.setAttribute('d', d);
    const destino = destinoDe(e);
    const destinoId = destino && (gesto.desdeSalida ? destino.destino : destino.origen).id;
    // Sobre una respuesta concreta se resalta solo esa; si no, el estado entero (agregaría una nueva)
    const salidaId = destino?.salida;
    $$('.fnode').forEach(f => f.classList.toggle('destino', f.dataset.id === destinoId && !salidaId));
    $$('.fsal li').forEach(li => li.classList.toggle('destino',
      !!salidaId && li.dataset.salida === salidaId && li.closest('.fnode').dataset.id === destinoId));
  }

  flow.addEventListener('pointermove', e => {
    if (!gesto) return;
    if (gesto.tipo === 'conectar') { moverConexion(e); return; }
    const dx = e.clientX - gesto.x0, dy = e.clientY - gesto.y0;
    if (Math.abs(dx) + Math.abs(dy) > 3) gesto.movido = true;
    if (gesto.tipo === 'pan') {
      vista.x = gesto.vx + dx;
      vista.y = gesto.vy + dy;
      aplicarVista();
    } else if (gesto.movido) {
      for (const g of gesto.grupo) {
        g.n.pos = { x: snap(g.px + dx / vista.z), y: snap(g.py + dy / vista.z) };
        g.el.classList.add('dragging');
        g.el.style.left = `${g.n.pos.x}px`;
        g.el.style.top = `${g.n.pos.y}px`;
      }
      dibujarConectores();
    }
  });

  const terminar = e => {
    if (!gesto) return;
    const g = gesto;
    const destino = g.tipo === 'conectar' && e.type === 'pointerup' ? destinoDe(e) : null;
    gesto = null;
    flow.classList.remove('panning', 'conectando');
    if (g.tipo === 'conectar') {
      if (destino) conectar(destino.origen, g.desdeSalida ? g.salida : destino.salida, destino.destino);
      else if (g.desdeSalida && e.type === 'pointerup') {
        // Soltado en el vacío: crea un estado nuevo ahí y lo conecta
        const nuevo = nodoVacio('estado');
        const p = aMundo(e);
        nuevo.pos = { x: snap(p.x), y: snap(p.y - CAB_H / 2) };
        nodos.push(nuevo);
        conectar(g.nodo, g.salida, nuevo);
        seleccionar(nuevo.id);
      } else renderArbol();
      return;
    }
    if (g.tipo === 'pan') {
      if (!g.movido && g.linea) desconectar(g.linea.padre, g.linea.salida);
      else if (!g.movido) cerrarDetalle();
      return;
    }
    if (!g.movido && g.shift) { marcar(g.nodo.id); return; }
    if (!g.movido) {
      seleccionar(g.nodo.id);
      if (g.salida) editarEnLienzo(g.nodo, g.salida);
      else if (g.nombre && g.nodo.id !== 'inicio') editarNombreEnLienzo(g.nodo);
      return;
    }
    cambio();
    renderArbol();
  };
  flow.addEventListener('pointerup', terminar);
  flow.addEventListener('pointercancel', terminar);

  flow.addEventListener('wheel', e => {
    if (e.target.closest('.nodo-card')) return;
    e.preventDefault();
    const r = flow.getBoundingClientRect();
    zoom(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  $('#zoomIn').onclick = () => zoom(1.2);
  $('#zoomOut').onclick = () => zoom(1 / 1.2);
  $('#flowFit').onclick = ajustar;
  $('#flowNuevo').onclick = () => agregarNodo('estado');
  $('#flowNuevaAccion').onclick = () => agregarNodo('accion');
  $('#flowNuevoSalto').onclick = () => agregarNodo('salto');
})();

function seleccionar(id) {
  seleccionado = id;
  confirmarTacho = null;
  marcados.clear();
  renderArbol();
  renderDetalle();
}

// Shift+clic: suma o saca un estado de la selección sin cambiar el que se está editando
function marcar(id) {
  if (id === seleccionado) { seleccionado = null; renderDetalle(); }
  else if (marcados.has(id)) marcados.delete(id);
  else marcados.add(id);
  confirmarTacho = null;
  renderArbol();
}

function cerrarDetalle() {
  seleccionado = null;
  confirmarTacho = null;
  marcados.clear();
  $('#nodoEditor').hidden = true;
  renderArbol();
}

// Reemplaza el texto de una respuesta en el lienzo por un campo para escribirla ahí mismo
function editarEnLienzo(n, salidaId) {
  const s = n.salidas?.find(x => x.id === salidaId);
  const li = $(`.fnode[data-id="${n.id}"] .fsal li[data-salida="${salidaId}"]`);
  if (!s || !li || s.cualquiera) return;
  const input = el('input', { class: 'fsal-input', value: s.texto || '', placeholder: 'Qué escucha', 'aria-label': 'Qué escucha' });
  input.addEventListener('input', () => { s.texto = input.value; cambio(); marcarRepetidas(n); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
  input.addEventListener('blur', rehacerTodo);
  li.firstChild.replaceWith(input);
  input.focus();
  input.select();
}

// Lo mismo para el nombre del estado, en su encabezado
function editarNombreEnLienzo(n) {
  const b = $(`.fnode[data-id="${n.id}"] .fhead b`);
  if (!b) return;
  const input = el('input', { class: 'fsal-input', value: n.nombre || '', placeholder: 'Nombre del estado', 'aria-label': 'Nombre del estado' });
  input.addEventListener('input', () => { n.nombre = input.value; cambio(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
  input.addEventListener('blur', rehacerTodo);
  b.replaceWith(input);
  input.focus();
  input.select();
}

// Nombre por defecto: "Estado n", "Acción n" o "Salto n", con n el primer número libre después de los de ese tipo
const NOMBRES = { estado: 'Estado', accion: 'Acción', salto: 'Salto' };
const tipoDe = n => NOMBRES[n.tipo] ? n.tipo : 'estado';
function nombreNuevo(tipo) {
  let i = nodos.filter(n => n.id !== 'inicio' && tipoDe(n) === tipo).length + 1;
  while (nodos.some(n => n.nombre === `${NOMBRES[tipo]} ${i}`)) i++;
  return `${NOMBRES[tipo]} ${i}`;
}

const nodoVacio = (tipo = 'estado') => tipo === 'accion' ? { id: nuevoId(), tipo, nombre: nombreNuevo(tipo), accion: null }
  : tipo === 'salto' ? { id: nuevoId(), tipo, nombre: nombreNuevo(tipo), objetivo: '' }
  : { id: nuevoId(), tipo, nombre: nombreNuevo(tipo), mensajes: [{ tipo: 'texto', texto: '' }], salidas: [], formatoOpciones: 'lista' };

// Un estado manda varios mensajes, en orden
function editorMensajes(n) {
  n.mensajes ??= [];
  const rehacer = () => { editado(); renderDetalle(); };
  const items = n.mensajes.map((m, i) => {
    const mover = d => { [n.mensajes[i], n.mensajes[i + d]] = [n.mensajes[i + d], n.mensajes[i]]; rehacer(); };
    const tipo = el('select', { 'aria-label': 'Tipo de mensaje', onchange: () => { m.tipo = tipo.value; rehacer(); } },
      ...Object.entries(TIPOS).map(([v, t]) => el('option', { value: v }, t)));
    tipo.value = TIPOS[m.tipo] ? m.tipo : 'texto';
    return el('div', { class: 'mensaje' },
      el('div', { class: 'mensaje-top' },
        el('span', { class: 'num' }, String(i + 1)), tipo,
        el('button', { type: 'button', class: 'icon-btn', title: 'Subir', 'aria-label': 'Subir', disabled: i === 0, onclick: () => mover(-1) }, '↑'),
        el('button', { type: 'button', class: 'icon-btn', title: 'Bajar', 'aria-label': 'Bajar', disabled: i === n.mensajes.length - 1, onclick: () => mover(1) }, '↓'),
        el('button', { type: 'button', class: 'icon-btn', title: 'Quitar', 'aria-label': 'Quitar mensaje', onclick: () => { n.mensajes.splice(i, 1); rehacer(); } }, '×')),
      ...contenido(m));
  });
  return el('div', { class: 'mensajes' }, ...items,
    el('button', { type: 'button', class: 'tree-add', onclick: () => { n.mensajes.push({ tipo: 'texto', texto: '' }); rehacer(); } }, '+ Agregar mensaje'));
}


/* ---------- Acciones de un estado ---------- */
const TIPOS_ACCION = { mail: 'Mandar un mail', whatsapp: 'Mandar un WhatsApp', sheets: 'Escribir en Google Sheets' };
const VARIABLES = '{nombre} {telefono} {mensaje} {fecha} {hora}';
const AYUDA_VARIABLES = '/ayuda/variables';

// Variables propias del agente: las que guardan los estados que preguntan algo
const variablesPropias = () => [...new Set(nodos.map(n => n.guardarEn).filter(Boolean))];

// "En los textos podés usar…" con las variables fijas y las que definió el usuario (o cómo definirlas)
function ayudaVariables(extra = '') {
  const propias = variablesPropias();
  return el('small', { class: 'help' }, `En los textos podés usar ${VARIABLES}. `,
    ...(propias.length ? [`Las que definiste: ${propias.map(v => `{${v}}`).join(' ')}. `] : []),
    'También podés usar variables propias: ', el('a', { href: AYUDA_VARIABLES, target: '_blank', rel: 'noopener', class: 'link-ayuda' }, 'cómo definir una variable'), '. ',
    extra);
}

// Nombre de variable válido: minúsculas, sin tildes ni espacios
const nombreVariable = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 30);
const accionVacia = tipo => ({
  mail: { tipo, para: '', asunto: '', cuerpo: '' },
  whatsapp: { tipo, numero: '', texto: '' },
  sheets: { tipo, planilla: '', hoja: '', modo: 'agregar', columnas: [{ columna: 'A', valor: '{fecha}' }, { columna: 'B', valor: '{nombre}' }, { columna: 'C', valor: '{telefono}' }], buscarColumna: 'C', buscarValor: '{telefono}', crear: true },
}[tipo]);

function camposAccion(a, rehacer) {
  switch (a.tipo) {
    case 'mail':
      return [
        campo('Para', a, 'para', { placeholder: 'ventas@tunegocio.com', type: 'email' }),
        campo('Asunto', a, 'asunto', { placeholder: 'Nuevo pedido de {nombre}' }),
        campo('Mensaje', a, 'cuerpo', { tipo: 'textarea', rows: 3, placeholder: '{nombre} (+{telefono}) escribió: {mensaje}' }),
        el('small', { class: 'help' }, 'Sale desde la casilla de avisos de la plataforma. Si responden, la respuesta te llega a tu mail.'),
      ];
    case 'whatsapp':
      return [
        campo('Número', a, 'numero', { placeholder: '5491123456789', inputMode: 'tel', ayuda: 'Con código de país y sin el 15. Puede ser {telefono} para escribirle al mismo cliente.' }),
        campo('Mensaje', a, 'texto', { tipo: 'textarea', rows: 3, placeholder: 'Nuevo contacto: {nombre} (+{telefono})' }),
        el('small', { class: 'help' }, 'Sale desde el número conectado del agente.'),
      ];
    case 'sheets': {
      const modo = el('select', { onchange: () => { a.modo = modo.value; rehacer(); } },
        el('option', { value: 'agregar' }, 'Agregar una fila'), el('option', { value: 'actualizar' }, 'Actualizar una fila'));
      modo.value = a.modo === 'actualizar' ? 'actualizar' : 'agregar';
      a.columnas ??= [];
      const siguiente = () => String.fromCharCode(65 + Math.min(25, Math.max(-1, ...a.columnas.map(c => (c.columna || 'A').toUpperCase().charCodeAt(0) - 65)) + 1));
      const crear = el('input', { type: 'checkbox', checked: a.crear !== false, onchange: () => { a.crear = crear.checked; editado(); } });
      const estadoPlanilla = el('small', { class: 'resultado mal' }, planillasError);
      const idActual = idDeLink(a.planilla);
      const lista = planillasCache;
      const selPlanilla = el('select', { 'aria-label': 'Planilla', onchange: async () => {
        if (selPlanilla.value === '__nueva') {
          selPlanilla.disabled = true;
          estadoPlanilla.className = 'resultado';
          estadoPlanilla.textContent = 'Creando…';
          try {
            const p = await crearPlanilla(nombrePlanillaNueva(), encabezadosDe(a));
            await cargarPlanillas(true);
            a.planilla = p.url;
            a.hoja = p.hoja;
            rehacer();
          } catch (err) {
            estadoPlanilla.className = 'resultado mal';
            estadoPlanilla.textContent = mensajeGoogle(err);
            selPlanilla.disabled = false;
            selPlanilla.value = idActual;
          }
          return;
        }
        a.planilla = lista?.find(p => p.id === selPlanilla.value)?.url || '';
        a.hoja = '';
        rehacer();
      } },
        el('option', { value: '' }, lista ? 'Elegí una planilla…' : planillasError ? 'Sin acceso a Google' : 'Cargando planillas…'),
        ...(lista || []).map(p => el('option', { value: p.id }, p.nombre)),
        idActual && !lista?.some(p => p.id === idActual) ? el('option', { value: idActual }, 'Planilla sin acceso: elegí otra') : null,
        lista ? el('option', { value: '__nueva' }, '+ Crear planilla nueva') : null);
      selPlanilla.value = idActual;
      if (!lista && !planillasError) cargarPlanillas().then(() => renderDetalle(), () => renderDetalle());

      // Hojas de la planilla elegida (la primera si no se eligió ninguna)
      const selHoja = el('select', { 'aria-label': 'Hoja', onchange: () => { a.hoja = selHoja.value; editado(); } },
        el('option', { value: a.hoja || '' }, a.hoja || (idActual ? 'Cargando…' : '—')));
      if (idActual && lista?.some(p => p.id === idActual)) {
        hojasDe(idActual).then(hs => {
          selHoja.replaceChildren(...hs.map(h => el('option', { value: h }, h)));
          if (!hs.includes(a.hoja)) { a.hoja = hs[0] || ''; editado(); }
          selHoja.value = a.hoja;
        }).catch(() => {});
      }
      return [
        el('label', {}, 'Planilla', selPlanilla),
        el('div', { class: 'accion-probar' },
          a.planilla ? el('a', { href: a.planilla, target: '_blank', rel: 'noopener', class: 'link-planilla' }, 'Abrir planilla ↗') : null,
          estadoPlanilla),
        el('small', { class: 'help' }, 'Las planillas están en el Drive de tu cuenta de Google conectada; las ves todas en la pestaña Planillas. Por seguridad, el agente solo puede escribir en planillas creadas desde acá.'),
        el('div', { class: 'row2' }, el('label', {}, 'Hoja', selHoja), el('label', {}, 'Qué hace', modo)),
        a.modo === 'actualizar' ? el('div', { class: 'row2' },
          campo('Buscar en la columna', a, 'buscarColumna', { placeholder: 'C', maxLength: 2 }),
          campo('El valor', a, 'buscarValor', { placeholder: '{telefono}' })) : null,
        a.modo === 'actualizar' ? el('label', { class: 'switch' }, crear, el('span', {}, 'Si no la encuentra, agregarla')) : null,
        el('label', {}, a.modo === 'actualizar' ? 'Escribir en esa fila' : 'Valores de la fila'),
        el('div', { class: 'columnas' },
          ...a.columnas.map((c, i) => el('div', { class: 'columna' },
            campoSuelto(c, 'columna', { placeholder: 'A', maxLength: 2, 'aria-label': 'Columna', class: 'col-letra' }),
            campoSuelto(c, 'valor', { placeholder: '{nombre}', 'aria-label': 'Valor' }),
            el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Quitar columna', onclick: () => { a.columnas.splice(i, 1); rehacer(); } }, '×'))),
          el('button', { type: 'button', class: 'tree-add', onclick: () => { a.columnas.push({ columna: siguiente(), valor: '' }); rehacer(); } }, '+ Columna')),
      ].filter(Boolean);
    }
    default:
      return [];
  }
}

/* ---------- Planillas de Google Sheets ---------- */
let planillasCache = null; // [{ id, nombre, url, modificada }]
let planillasError = '';
let planillasCargando = null;
const hojasCache = new Map();
const idDeLink = s => String(s || '').match(/\/d\/([\w-]+)/)?.[1] || '';
const mensajeGoogle = err => /no está conectada/.test(err.message) ? 'Conectá tu cuenta de Google en General → Integraciones.' : err.message;

function cargarPlanillas(forzar = false) {
  if (planillasCache && !forzar) return Promise.resolve(planillasCache);
  if (planillasCargando && !forzar) return planillasCargando;
  planillasCargando = api('GET', '/api/planillas')
    .then(ps => { planillasCache = ps; planillasError = ''; return ps; })
    .catch(err => { planillasCache = null; planillasError = mensajeGoogle(err); throw err; })
    .finally(() => { planillasCargando = null; });
  return planillasCargando;
}

const crearPlanilla = (titulo, encabezados = []) => api('POST', '/api/planillas', { titulo, encabezados });

// "<Agente> - Planilla N", con N el siguiente número libre para ese agente
function nombrePlanillaNueva() {
  const prefijo = `${form.elements['agente.nombre'].value.trim() || 'Agente'} - Planilla `;
  const usados = (planillasCache || []).map(p => p.nombre.startsWith(prefijo) ? Number(p.nombre.slice(prefijo.length)) : 0).filter(Number.isInteger);
  return prefijo + (Math.max(0, ...usados) + 1);
}

function hojasDe(id) {
  if (!hojasCache.has(id)) hojasCache.set(id, api('GET', `/api/planillas/${id}/hojas`).catch(err => { hojasCache.delete(id); throw err; }));
  return hojasCache.get(id);
}

// Títulos de la primera fila: la variable de cada columna ({nombre} → Nombre) o su letra
function encabezadosDe(a) {
  const encabezados = [];
  for (const c of a.columnas || []) {
    const i = (c.columna || '').toUpperCase().charCodeAt(0) - 65;
    if (i >= 0 && i < 26) encabezados[i] = (c.valor || '').replace(/[{}]/g, '').replace(/^\w/, l => l.toUpperCase()) || c.columna.toUpperCase();
  }
  return Array.from(encabezados, (v, i) => v || String.fromCharCode(65 + i));
}

// Vista previa de solo lectura con aspecto de Google Sheets: letras de columna, números de fila y pestañas de hoja
function vistaPlanilla(p) {
  const caja = el('div', { class: 'preview' }, el('small', {}, 'Cargando…'));
  const letra = i => String.fromCharCode(65 + i);
  const cargar = async hoja => {
    try {
      const d = await api('GET', `/api/planillas/${p.id}/preview${hoja ? `?hoja=${encodeURIComponent(hoja)}` : ''}`);
      const { hojas } = d;
      const cols = Math.max(8, ...d.filas.map(f => f.length));
      const filas = Math.max(10, d.filas.length);
      const tabla = el('table', {},
        el('tr', {}, el('th', {}), ...Array.from({ length: cols }, (_, i) => el('th', {}, letra(i)))),
        ...Array.from({ length: filas }, (_, r) => el('tr', {}, el('th', {}, String(r + 1)),
          ...Array.from({ length: cols }, (_, i) => el('td', {}, d.filas[r]?.[i] ?? '')))));
      const tabs = el('div', { class: 'preview-tabs' }, ...hojas.map(h =>
        el('button', { type: 'button', class: h === d.hoja ? 'on' : '', onclick: () => cargar(h) }, h)));
      caja.replaceChildren(el('div', { class: 'preview-tabla' }, tabla), tabs);
    } catch (err) { caja.replaceChildren(el('small', { class: 'mal' }, err.message)); }
  };
  cargar();
  return caja;
}

async function pintarPlanillas() {
  const lista = $('#planillasLista'), estado = $('#planillasEstado');
  estado.className = 'help';
  estado.textContent = 'Cargando…';
  try {
    await guardarPendiente();
    const ps = await cargarPlanillas(true);
    $('#planillaNombre').placeholder = `Nombre (si lo dejás vacío: ${nombrePlanillaNueva()})`;
    estado.textContent = ps.length ? '' : 'Todavía no hay planillas. Creá una acá o desde una acción de Sheets.';
    const fecha = f => new Date(f).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    lista.replaceChildren(...ps.map(p => el('li', {},
      el('div', {}, el('b', {}, p.nombre),
        el('small', {}, `Modificada ${fecha(p.modificada)} · `,
          el('span', { class: p.acciones ? 'uso' : 'sin-uso' }, p.acciones
            ? `Referenciada por ${p.acciones} ${p.acciones === 1 ? 'acción' : 'acciones'} (${p.agentes.join(', ')})`
            : 'Sin acciones que la usen'))),
      el('a', { href: p.url, target: '_blank', rel: 'noopener', class: 'btn btn-outline btn-sm' }, 'Abrir ↗'), vistaPlanilla(p))));
  } catch {
    estado.className = 'help mal';
    estado.textContent = planillasError;
    lista.replaceChildren();
  }
}

$('#planillaCrear').onclick = async () => {
  const boton = $('#planillaCrear');
  boton.disabled = true;
  try {
    await guardarPendiente();
    await crearPlanilla($('#planillaNombre').value.trim() || nombrePlanillaNueva());
    $('#planillaNombre').value = '';
    await pintarPlanillas();
  } catch (err) {
    $('#planillasEstado').className = 'help mal';
    $('#planillasEstado').textContent = mensajeGoogle(err);
  }
  boton.disabled = false;
};

// Input sin etiqueta, atado a una clave del objeto
function campoSuelto(obj, clave, attrs) {
  const i = el('input', { value: obj[clave] ?? '', ...attrs });
  i.addEventListener('input', () => { obj[clave] = i.value; editado(); });
  return i;
}

// Un nodo de acción hace una sola acción: se elige el tipo y se completa
function editorAccion(n) {
  const rehacer = () => { editado(); renderDetalle(); };
  const tipo = el('select', { 'aria-label': 'Qué hace', onchange: () => {
    n.accion = tipo.value ? { id: nuevoId(), ...accionVacia(tipo.value) } : null;
    rehacer();
  } }, el('option', { value: '' }, 'Elegí una acción…'), ...Object.entries(TIPOS_ACCION).map(([v, t]) => el('option', { value: v }, t)));
  const a = n.accion;
  tipo.value = a?.tipo || '';
  if (!a) return el('div', { class: 'mensajes' }, el('label', {}, 'Qué hace', tipo));

  const resultado = el('small', { class: 'resultado' });
  const probar = el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async () => {
    probar.disabled = true;
    resultado.className = 'resultado';
    resultado.textContent = 'Probando…';
    try {
      await guardarPendiente();
      const r = await api('POST', `/api/bots/${botId}/acciones/probar`, { accion: a });
      resultado.classList.add(r.ok ? 'ok' : 'mal');
      resultado.textContent = r.detalle;
    } catch (err) {
      resultado.classList.add('mal');
      resultado.textContent = err.message;
    }
    probar.disabled = false;
  } }, 'Probar');
  return el('div', { class: 'mensajes' },
    el('label', {}, 'Qué hace', tipo),
    el('div', { class: 'mensaje accion' },
      ...camposAccion(a, rehacer),
      el('div', { class: 'accion-probar' }, probar, resultado)),
    ayudaVariables('"Probar" la ejecuta de verdad con datos de prueba.'));
}

// Lo que escucha el estado: cada respuesta tiene su propia salida en el lienzo
function editorSalidas(n) {
  n.salidas ??= [];
  const rehacer = () => { editado(); renderDetalle(); };
  const entrada = (s, clave, attrs) => {
    const i = el('input', { value: s[clave] || '', ...attrs });
    i.addEventListener('input', () => { s[clave] = i.value; editado(); marcarRepetidas(n); });
    return i;
  };
  const lista = el('div', { class: 'mensajes' },
    ...n.salidas.map((s, i) => {
      const destino = nodo(s.destino);
      const mover = d => { [n.salidas[i], n.salidas[i + d]] = [n.salidas[i + d], n.salidas[i]]; rehacer(); };
      return el('div', { class: `mensaje${s.cualquiera ? ' cualquiera' : ''}`, 'data-salida': s.id },
        el('div', { class: 'mensaje-top' },
          el('span', { class: 'num' }, s.cualquiera ? '✱' : String(i + 1)),
          s.cualquiera
            ? el('b', { class: 'accion-tipo' }, `Cualquier otra respuesta${n.guardarEn ? ` (se guarda en {${n.guardarEn}})` : ''}`)
            : entrada(s, 'texto', { placeholder: 'hola', 'aria-label': 'Qué escucha' }),
          el('button', { type: 'button', class: 'icon-btn', title: 'Subir', 'aria-label': 'Subir', disabled: i === 0, onclick: () => mover(-1) }, '↑'),
          el('button', { type: 'button', class: 'icon-btn', title: 'Bajar', 'aria-label': 'Bajar', disabled: i === n.salidas.length - 1, onclick: () => mover(1) }, '↓'),
          el('button', { type: 'button', class: 'icon-btn', title: 'Quitar', 'aria-label': 'Quitar respuesta', onclick: () => { n.salidas.splice(i, 1); rehacer(); } }, '×')),
        s.cualquiera ? null : entrada(s, 'disparadores', { placeholder: 'También: buenas, buen día', 'aria-label': 'Otras formas de decirlo' }),
        el('small', { class: 'error' }),
        el('small', { class: 'help' }, 'Lleva a ',
          destino ? el('button', { type: 'button', class: 'link', onclick: () => seleccionar(destino.id) }, nombreDe(destino))
            : 'ningún estado: arrastrá su punto en el lienzo hasta uno.'));
    }),
    el('button', { type: 'button', class: 'tree-add', onclick: () => agregarSalida(n) }, '+ Agregar respuesta'));
  requestAnimationFrame(() => marcarRepetidas(n));
  return lista;
}

// Estado que pregunta algo: lo que conteste el cliente se guarda en una variable, y la charla sigue
// por la salida "Cualquier respuesta" (que se agrega sola)
function guardarEnVariable(n) {
  const input = el('input', { value: n.guardarEn || '', placeholder: 'nombre_cliente', 'aria-label': 'Variable donde se guarda la respuesta' });
  input.addEventListener('input', () => {
    const limpio = nombreVariable(input.value);
    if (input.value !== limpio) input.value = limpio;
    n.guardarEn = limpio;
    editado();
  });
  input.addEventListener('change', () => {
    if (n.guardarEn && !(n.salidas || []).some(s => s.cualquiera)) (n.salidas ??= []).push({ id: nuevoId(), cualquiera: true, destino: null });
    editado();
    renderDetalle();
  });
  return el('label', {}, 'Guardar lo que responda en una variable', input,
    el('small', {}, n.guardarEn
      ? `Después la usás como {${n.guardarEn}} en mensajes y acciones. Conectá "Cualquier respuesta" al estado que sigue.`
      : 'Opcional. Por ejemplo, si este estado pregunta el nombre, guardalo en nombre_cliente.'));
}

// Cómo se ofrecen las respuestas: lista numerada, encuesta de WhatsApp o sin mostrarlas (solo escucha)
function formatoOpciones(n, esRaiz) {
  const formato = el('select', { onchange: () => { n.formatoOpciones = formato.value; editado(); renderDetalle(); } },
    el('option', { value: 'lista' }, 'Lista numerada'),
    el('option', { value: 'encuesta' }, 'Encuesta de WhatsApp'),
    el('option', { value: 'ninguno' }, 'No mostrarlas (solo escuchar)'));
  formato.value = ['encuesta', 'ninguno'].includes(n.formatoOpciones) ? n.formatoOpciones : 'lista';
  const ayuda = {
    lista: `Se mandan numeradas después del último mensaje${esRaiz ? '' : ', con 0 para volver al menú anterior'}.`,
    encuesta: 'Se elige con un toque. Hasta 12 opciones; si hay más, se mandan numeradas.',
    ninguno: 'El cliente no las ve: el agente solo reacciona si escribe algo que coincida.',
  }[formato.value];
  return [
    el('label', {}, 'Cómo se ofrecen', formato),
    formato.value === 'encuesta' ? campo('Pregunta de la encuesta', n, 'pregunta', { placeholder: 'Elegí una opción' }) : null,
    el('small', { class: 'help' }, ayuda),
  ].filter(Boolean);
}

// Marca en el panel y en el lienzo las respuestas repetidas del estado, mientras se escribe
function marcarRepetidas(n) {
  const dups = repetidas(n);
  for (const card of $$(`#nodoEditor .mensaje[data-salida]`)) {
    const frase = dups.get(card.dataset.salida);
    card.classList.toggle('dup', !!frase);
    card.querySelector('.error').textContent = frase ? `Repetida: otra respuesta de este estado también escucha "${frase}". El agente no sabría cuál elegir.` : '';
  }
  for (const li of $$(`.fnode[data-id="${n.id}"] .fsal li`)) {
    const frase = dups.get(li.dataset.salida);
    li.classList.toggle('dup', !!frase);
    li.title = frase ? `Repetida: otra respuesta también escucha "${frase}"` : '';
  }
  $(`.fnode[data-id="${n.id}"]`)?.classList.toggle('con-error', dups.size > 0);
}

// Agrega una respuesta sin conectar y deja el cursor en su texto (en el lienzo); el destino se conecta a mano
function agregarSalida(n) {
  const s = nuevaSalida();
  (n.salidas ??= []).push(s);
  cambio();
  seleccionar(n.id);
  editarEnLienzo(n, s.id);
}

function eliminarEstado(n) {
  nodos = nodos.filter(x => x !== n);
  for (const p of nodos) for (const s of p.salidas || []) if (s.destino === n.id) s.destino = null;
  cambio();
  cerrarDetalle();
}

// Tachito del estado: el primer clic pide confirmación; el segundo quita la última respuesta
// o, si no le quedan, elimina el estado (salvo el inicio)
function quitarUltima(n) {
  if (confirmarTacho !== n.id) {
    confirmarTacho = n.id;
    renderArbol();
    return;
  }
  confirmarTacho = null;
  const filas = filasDe(n);
  if (filas.length) {
    filas.pop();
    rehacerTodo();
  } else if (n.id !== 'inicio') {
    eliminarEstado(n);
  }
}

// Estado en blanco, sin conectar, en el centro de lo que se ve
function agregarNodo(tipo) {
  const nuevo = nodoVacio(tipo);
  nuevo.pos = centroVista();
  const pisa = p => nodos.some(n => Math.abs(n.pos.x - p.x) < NODO_W + GRID && p.y < n.pos.y + altoNodo(n) + GRID && n.pos.y < p.y + CAB_H + GRID);
  while (pisa(nuevo.pos)) nuevo.pos.y += CAB_H + SEP;
  nodos.push(nuevo);
  cambio();
  seleccionar(nuevo.id);
  $('#nodoEditor .lapiz')?.click();
}

function renderDetalle() {
  const n = nodo(seleccionado);
  const panel = $('#nodoEditor');
  if (!n) { panel.hidden = true; return; }
  panel.hidden = false;
  const esRaiz = n.id === 'inicio';
  const camino = caminos().get(n.id);
  const otros = padresDe(n).filter(p => p !== camino?.at(-2));
  const cerrar = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Cerrar', onclick: cerrarDetalle }, '×');
  const actual = el('b', { class: 'ruta-actual' }, nombreDe(n));
  const lapiz = el('button', { type: 'button', class: 'lapiz', title: 'Cambiar nombre', 'aria-label': 'Cambiar nombre', onclick: () => {
    const etiqueta = n.tipo === 'accion' ? 'Nombre de la acción' : n.tipo === 'salto' ? 'Nombre del salto' : 'Nombre del estado';
    const input = el('input', { class: 'ruta-input', value: n.nombre || '', placeholder: etiqueta, 'aria-label': etiqueta });
    input.addEventListener('input', () => { n.nombre = input.value; editado(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
    input.addEventListener('blur', () => renderDetalle());
    actual.replaceWith(input);
    lapiz.remove();
    input.focus();
    input.select();
  } });
  lapiz.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
  const ruta = esRaiz ? el('h3', {}, 'Inicio') : el('div', { class: 'ruta' },
    ...(camino || []).slice(0, -1).flatMap(p => [
      el('button', { type: 'button', onclick: () => seleccionar(p.id) }, nombreDe(p)),
      el('span', {}, '›'),
    ]), actual, lapiz);

  const eliminar = el('div', { class: 'nodo-actions' },
    el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger', onclick: () => eliminarEstado(n) }, 'Eliminar'));

  if (n.tipo === 'salto') {
    const nombres = [...new Set(nodos.filter(x => !terminal(x) && (x.id === 'inicio' || x.nombre)).map(nombreDe))];
    const lista = el('datalist', { id: `saltos-${n.id}` }, ...nombres.map(v => el('option', { value: v })));
    const objetivo = el('input', { value: n.objetivo || '', list: lista.id, placeholder: 'Nombre del estado', 'aria-label': 'Estado al que salta' });
    const aviso = el('p', { class: 'help' });
    const revisar = () => {
      const ok = nombres.some(v => normalizar(v) === normalizar(objetivo.value));
      aviso.textContent = !objetivo.value.trim() ? '' : ok ? '' : `No hay ningún estado llamado "${objetivo.value.trim()}": la charla va a responder como si no hubiera entendido.`;
    };
    objetivo.addEventListener('input', () => { n.objetivo = objetivo.value; editado(); revisar(); });
    revisar();
    panel.replaceChildren(...[
      el('div', { class: 'nodo-top' }, ruta, cerrar),
      el('p', { class: 'help' }, 'Nodo de salto: cuando el cliente llega acá, la charla sigue en el estado con este nombre, como si hubiera elegido llegar ahí.'),
      !camino ? el('p', { class: 'help' }, 'Ninguna respuesta lleva a este salto. Arrastrá el punto de una respuesta de un estado hasta acá.') : null,
      otros.length ? el('p', { class: 'help' }, 'También se llega desde: ',
        ...otros.flatMap((p, i) => [i ? ', ' : '', el('button', { type: 'button', class: 'link', onclick: () => seleccionar(p.id) }, nombreDe(p))])) : null,
      el('label', {}, 'Salta al estado'),
      objetivo, lista, aviso,
      eliminar,
    ].filter(Boolean));
    return;
  }

  if (n.tipo === 'accion') {
    panel.replaceChildren(...[
      el('div', { class: 'nodo-top' }, ruta, cerrar),
      el('p', { class: 'help' }, 'Nodo de acción: cuando el cliente llega acá se ejecuta esta acción. Es terminal: no manda mensajes ni escucha respuestas, y la charla sigue en el menú desde donde vino.'),
      !camino ? el('p', { class: 'help' }, 'Ninguna respuesta lleva a esta acción. Arrastrá el punto de una respuesta de un estado hasta acá.') : null,
      otros.length ? el('p', { class: 'help' }, 'También se llega desde: ',
        ...otros.flatMap((p, i) => [i ? ', ' : '', el('button', { type: 'button', class: 'link', onclick: () => seleccionar(p.id) }, nombreDe(p))])) : null,
      editorAccion(n),
      eliminar,
    ].filter(Boolean));
    return;
  }

  panel.replaceChildren(...[
    el('div', { class: 'nodo-top' }, ruta, cerrar),
    esRaiz ? el('p', { class: 'help' }, 'Donde arranca la charla: lo primero que recibe el cliente cuando escribe.') : null,
    !camino ? el('p', { class: 'help' }, 'Ninguna respuesta lleva a este estado. Arrastrá el punto de una respuesta de otro estado hasta acá.') : null,
    otros.length ? el('p', { class: 'help' }, 'También se llega desde: ',
      ...otros.flatMap((p, i) => [i ? ', ' : '', el('button', { type: 'button', class: 'link', onclick: () => seleccionar(p.id) }, nombreDe(p))])) : null,
    el('label', {}, 'Mensajes que envía'),
    editorMensajes(n),
    ayudaVariables(),
    guardarEnVariable(n),
    el('label', {}, 'Respuestas que escucha'),
    editorSalidas(n),
    ...((n.salidas || []).some(s => !s.cualquiera) ? formatoOpciones(n, esRaiz) : []),
    esRaiz ? null : eliminar,
  ].filter(Boolean));
}

function cargarFlujo(f) {
  nodos = structuredClone(f?.nodos || []);
  if (!nodo('inicio')) nodos.unshift({ id: 'inicio', mensajes: [], salidas: [] });
  for (const n of nodos) if (n.id !== 'inicio' && !n.nombre?.trim()) n.nombre = nombreNuevo(tipoDe(n));
  if (nodos.some(n => !n.pos)) ordenar();
  if (!nodo(seleccionado)) seleccionado = null;
  renderArbol();
  renderDetalle();
  ajustar();
}

/* ---------- Secciones ---------- */
function mostrarSeccion(sec) {
  const s = $(`.sec[data-sec="${sec}"]`);
  if (!s || $(`.sections button[data-sec="${sec}"]`)?.disabled) sec = 'respuestas';
  $$('.sec').forEach(s => (s.hidden = s.dataset.sec !== sec));
  $$('.sections button').forEach(b => b.setAttribute('aria-current', String(b.dataset.sec === sec)));
  if (location.hash.slice(1) !== sec) history.replaceState(null, '', `#${sec}`);
  if (sec === 'metricas') cargarMetricas();
  if (sec === 'planillas') pintarPlanillas();
  if (sec === 'respuestas') { if (ajustarAlMostrar) ajustar(); dibujarConectores(); }
}
$$('.sections button').forEach(b => (b.onclick = () => mostrarSeccion(b.dataset.sec)));

/* ---------- Agentes ---------- */
function mostrarTester(abierto) {
  $('.app').classList.toggle('tester-cerrado', !abierto);
  $('.tester-head').inert = $('.phone').inert = !abierto;
  const t = $('#tToggle'), txt = abierto ? 'Ocultar vista previa' : 'Mostrar vista previa';
  t.title = txt; t.setAttribute('aria-label', txt); t.setAttribute('aria-expanded', abierto);
  if (abierto) $('#tInput').focus({ preventScroll: true });
  dibujarConectores();
}
$('#abrirProbar').onclick = () => mostrarTester(true);
$('#tToggle').onclick = () => mostrarTester($('.app').classList.contains('tester-cerrado'));
$('.app').addEventListener('transitionend', e => { if (e.target === e.currentTarget) dibujarConectores(); });

async function abrirBot(id) {
  await guardarPendiente();
  const bot = await api('GET', `/api/bots/${id}`);
  botId = bot.id;
  guardarLocal('botId', botId);
  $('.app').classList.add('probando');
  mostrarSeccion($('.sections button[aria-current="true"]')?.dataset.sec);
  llenarForm(bot);
  pintarEstado({ estado: 'desconectado', proveedor: bot.conexion?.proveedor, ...bot.estado });
  // Con WhatsApp personal, si está desconectado se conecta solo: retoma la sesión recordada o muestra el QR
  if ((bot.estado?.estado || 'desconectado') === 'desconectado' && bot.conexion?.proveedor === 'baileys') {
    api('POST', `/api/bots/${bot.id}/conectar`).then(r => { if (botId === bot.id) pintarEstado(r); }).catch(() => {});
  }
  reiniciarConvs();
  reiniciarChat(false);
  $('#saved').textContent = '';
  escucharEventos();
  if (!$('.sec[data-sec="metricas"]').hidden) cargarMetricas();
}

async function crearAgente() {
  await guardarPendiente();
  const bot = await api('POST', '/api/bots', {});
  bots.push({ id: bot.id, nombre: bot.agente.nombre, estado: 'desconectado' });
  await abrirBot(bot.id);
  mostrarSeccion('comportamiento');
  form.elements['agente.nombre'].select();
}

/* ---------- Descargar el agente ---------- */
async function prepararDescarga() {
  const disponibles = await api('GET', '/api/descargas').catch(() => []);
  for (const a of $$('.descarga a[data-plataforma]')) {
    const ok = disponibles.includes(a.dataset.plataforma);
    a.setAttribute('aria-disabled', String(!ok));
    if (!ok) a.title = 'Todavía no está disponible';
    a.onclick = async e => {
      e.preventDefault();
      await guardarPendiente();
      location.href = `/api/bots/${botId}/descargar?plataforma=${a.dataset.plataforma}`;
    };
  }
}

/* ---------- Estado del servidor ---------- */
// Verde: responde bien · amarillo: lento o avisado como degradado · rojo: no responde o avisado como caído
const TEXTOS_SERVIDOR = { operativo: 'Servidores operativos', degradado: 'Servidores bajo carga', caido: 'Sin contacto con servidores' };
async function revisarServidor() {
  const t0 = performance.now();
  let estado = 'caido';
  try {
    const res = await fetch('/api/estado', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (res.ok) estado = (await res.json()).estado;
    if (estado === 'operativo' && performance.now() - t0 > 2000) estado = 'degradado';
  } catch {}
  $('#servidor').dataset.estado = estado;
  $('#servidorTexto').textContent = TEXTOS_SERVIDOR[estado] || TEXTOS_SERVIDOR.operativo;
}
setInterval(revisarServidor, 30000);

/* ---------- Borrar agente ---------- */
(() => {
  const modal = $('#modalBorrar'), input = $('#modalBorrarInput'), confirmar = $('#modalBorrarConfirmar'), error = $('#modalBorrarError');
  const nombreActual = () => form.elements['agente.nombre'].value.trim() || 'Asistente';
  const cerrar = () => { modal.hidden = true; };

  $('#borrarAgente').onclick = () => {
    $('#modalBorrarNombre').textContent = nombreActual();
    input.value = '';
    confirmar.disabled = true;
    error.hidden = true;
    modal.hidden = false;
    input.focus();
  };
  input.addEventListener('input', () => { confirmar.disabled = input.value.trim() !== nombreActual(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !confirmar.disabled) confirmar.click(); });
  $('#modalBorrarCancelar').onclick = cerrar;
  modal.addEventListener('click', e => { if (e.target === modal) cerrar(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) cerrar(); });

  confirmar.onclick = async () => {
    confirmar.disabled = true;
    // Que no quede un guardado pendiente sobre un agente que ya no existe
    clearTimeout(timerGuardado);
    timerGuardado = null;
    try {
      await guardando;
      await api('DELETE', `/api/bots/${botId}`);
      eventos?.close();
      bots = bots.filter(b => b.id !== botId);
      botId = null;
      cerrar();
      await crearAgente();
    } catch (err) {
      error.textContent = `No se pudo borrar: ${err.message}`;
      error.hidden = false;
      confirmar.disabled = false;
    }
  };
})();

/* ---------- Conexión ---------- */
const ETIQUETAS = { desconectado: 'Desconectado', conectando: 'Desconectado', esperando_qr: 'Desconectado', conectado: 'Conectado', error: 'Error' };

function pintarEstado(s) {
  for (const pill of [$('#pill'), $('#pill2')]) {
    pill.dataset.estado = ['conectando', 'esperando_qr'].includes(s.estado) ? 'desconectado' : s.estado;
    pill.textContent = ETIQUETAS[s.estado] || s.estado;
  }
  $('#statusDetail').textContent = s.estado === 'conectado' && s.numero ? `Respondiendo en +${s.numero}` : s.detalle || '';
  const mostrarQR = s.qr && (s.estado === 'esperando_qr' || s.estado === 'desconectado');
  $('#qrBoxConexion').hidden = !(mostrarQR && s.proveedor === 'baileys');
  if (s.qr) {
    $('#qrImgConexion').src = s.qr;
  }
  const activo = s.estado === 'conectado';
  const baileys = s.proveedor === 'baileys';
  $('#btnConectar').hidden = activo;
  $('#btnDesconectar').hidden = !activo;
  // Con sesión recordada solo se ofrece desvincular; sin sesión se muestra el QR
  $('#btnLogout').hidden = !(baileys && (s.estado === 'conectado' || s.estado === 'error'));
  const b = bots.find(b => b.id === botId);
  if (b && b.estado !== s.estado) { b.estado = s.estado; }
}

const convs = new Map(); // chatId -> { nombre, msgs, leido }
let convSel = null;
const horaLog = ts => new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

function reiniciarConvs() {
  convs.clear();
  convSel = null;
  pintarConvs();
}

function pintarConvs() {
  $('#logCount').textContent = convs.size || '';
  $('#logEmpty').hidden = convs.size > 0;
  $('#conv').hidden = convs.size === 0;
  if (!convs.size) return;
  if (!convs.has(convSel)) convSel = [...convs.keys()][0];
  const orden = [...convs].sort((a, b) => b[1].msgs.at(-1).ts - a[1].msgs.at(-1).ts);
  $('#convLista').replaceChildren(...orden.map(([id, c]) => {
    const ult = c.msgs.at(-1);
    const sinLeer = c.msgs.length - c.leido;
    return el('li', { class: id === convSel ? 'sel' : '' },
      el('button', { type: 'button', onclick: () => { convSel = id; pintarConvs(); } },
        el('span', { class: 'conv-top' },
          el('b', {}, c.nombre),
          el('time', {}, horaLog(ult.ts))),
        el('span', { class: 'conv-bot' },
          el('span', { class: 'conv-prev' }, `${ult.de === 'bot' ? 'Agente: ' : ''}${ult.texto}`),
          sinLeer > 0 && id !== convSel ? el('span', { class: 'count' }, sinLeer) : null)));
  }));
  const c = convs.get(convSel);
  c.leido = c.msgs.length;
  $('#convHead').textContent = `${c.nombre} · ${c.msgs.length} mensajes`;
  const msgs = $('#convMsgs');
  const abajo = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
  msgs.replaceChildren(...c.msgs.map(m => el('div', { class: `msg ${m.de === 'bot' ? 'bot' : 'yo'}`, title: horaLog(m.ts) },
    m.texto, el('small', { class: 'msg-hora' }, horaLog(m.ts)))));
  if (abajo || c.msgs.length === 1) msgs.scrollTop = msgs.scrollHeight;
}

function agregarLog(m) {
  let c = convs.get(m.chatId);
  if (!c) convs.set(m.chatId, c = { nombre: m.chatId.split('@')[0], msgs: [], leido: 0 });
  if (m.de !== 'bot' && m.nombre) c.nombre = m.nombre;
  c.msgs.push(m);
  pintarConvs();
}

function escucharEventos() {
  eventos?.close();
  eventos = new EventSource(`/api/bots/${botId}/eventos`);
  eventos.addEventListener('status', e => pintarEstado(JSON.parse(e.data)));
  eventos.addEventListener('mensaje', e => agregarLog(JSON.parse(e.data)));
  eventos.addEventListener('metricas', () => { if (!$('.sec[data-sec="metricas"]').hidden) cargarMetricas(); });
}

async function accion(boton, fn) {
  boton.disabled = true;
  try { await fn(); }
  catch (err) { $('#statusDetail').textContent = err.message; mostrarSeccion('comportamiento'); }
  finally { boton.disabled = false; }
}

$('#btnConectar').onclick = e => accion(e.currentTarget, async () => {
  await guardarPendiente();
  mostrarSeccion('comportamiento');
  pintarEstado(await api('POST', `/api/bots/${botId}/conectar`));
});
$('#btnDesconectar').onclick = e => accion(e.currentTarget, () => api('POST', `/api/bots/${botId}/desconectar`));
$('#btnLogout').onclick = e => accion(e.currentTarget, async () => {
  if (!confirm('¿Desvincular este número? Para volver a conectarlo hay que escanear el QR de nuevo.')) return;
  await api('POST', `/api/bots/${botId}/desconectar`, { cerrarSesion: true });
  pintarEstado(await api('POST', `/api/bots/${botId}/conectar`));
});

/* ---------- Métricas ---------- */
const FUENTES = {
  inicio: 'Inicio',
  opcion: 'Opción elegida',
  llm: 'LLM',
  sin_coincidencia: 'No entendió',
}
const fmt = n => n.toLocaleString('es-AR');
const fechaCorta = f => { const [, m, d] = f.split('-'); return `${Number(d)}/${Number(m)}`; };

async function cargarMetricas() {
  if (!botId) return;
  const m = await api('GET', `/api/bots/${botId}/metricas`).catch(() => null);
  if (!m) return;
  $('#kRecibidos').textContent = fmt(m.recibidos);
  $('#kChats').textContent = fmt(m.conversaciones);
  $('#kResueltos').textContent = m.recibidos ? `${Math.round((m.resueltos / m.recibidos) * 100)}%` : '–';
  $('#kResueltosAbs').textContent = m.recibidos ? `${fmt(m.resueltos)} de ${fmt(m.recibidos)}` : '';
  $('#kTiempo').textContent = m.recibidos ? (m.msPromedio < 1000 ? `${m.msPromedio} ms` : `${(m.msPromedio / 1000).toFixed(1)} s`) : '–';

  const max = Math.max(1, ...m.serie.map(d => d.recibidos));
  const iMax = m.serie.findIndex(d => d.recibidos === max && max > 0);
  const tip = $('#tip');
  $('#bars').replaceChildren(...m.serie.map((d, i) => {
    const alto = (d.recibidos / max) * 100;
    const barra = el('div', { class: 'bar' }, el('i'));
    barra.firstChild.style.height = `${alto}%`;
    // Etiqueta solo en el máximo y en hoy
    if (d.recibidos && (i === iMax || i === m.serie.length - 1)) {
      const lbl = el('em', {}, fmt(d.recibidos));
      lbl.style.bottom = `calc(${alto}% + 2px)`;
      barra.append(lbl);
    }
    barra.addEventListener('mousemove', e => {
      tip.hidden = false;
      tip.textContent = `${fechaCorta(d.fecha)} · ${fmt(d.recibidos)} mensajes · ${fmt(d.conversaciones)} conversaciones`;
      tip.style.left = `${e.clientX + 12}px`;
      tip.style.top = `${e.clientY - 34}px`;
    });
    barra.addEventListener('mouseleave', () => (tip.hidden = true));
    return barra;
  }));
  let labels = $('#bars').nextElementSibling;
  if (!labels?.classList.contains('bar-labels')) {
    labels = el('div', { class: 'bar-labels', 'aria-hidden': 'true' });
    $('#bars').after(labels);
  }
  labels.replaceChildren(...m.serie.map((d, i) => el('span', {}, i % 2 === m.serie.length % 2 ? '' : fechaCorta(d.fecha))));
  $('#tDias').replaceChildren(...[...m.serie].reverse().map(d =>
    el('tr', {}, el('td', {}, fechaCorta(d.fecha)), el('td', {}, fmt(d.recibidos)), el('td', {}, fmt(d.conversaciones)))));

  const filasFuente = Object.entries(FUENTES).map(([k, t]) => {
    const n = m.porFuente[k] || 0;
    const pct = m.recibidos ? ` ${Math.round((n / m.recibidos) * 100)}%` : '';
    return el('tr', {}, el('td', {}, t), el('td', {}, fmt(n), el('span', { class: 'sub' }, pct)));
  });
  $('#tFuentes').replaceChildren(...filasFuente);
  $('#tTop').replaceChildren(...(m.top.length
    ? m.top.map(t => el('tr', {}, el('td', {}, t.titulo), el('td', {}, fmt(t.usos))))
    : [el('tr', {}, el('td', { class: 'help' }, 'Sin datos todavía'), el('td'))]));
}
setInterval(() => { if (!document.hidden && !$('.sec[data-sec="metricas"]').hidden) cargarMetricas(); }, 500);

/* ---------- Probador ---------- */
const chat = $('#chat');
const bajar = () => (chat.scrollTop = chat.scrollHeight);

const horaChat = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

function burbuja(clase, ...contenido) {
  const conHora = /^(yo|bot)$/.test(clase);
  const b = el('div', { class: `msg ${clase}` }, ...contenido,
    conHora ? el('span', { class: 'wa-hora' }, horaChat(), clase === 'yo' ? el('i', { class: 'wa-check', 'aria-hidden': 'true' }) : null) : null);
  chat.append(b);
  bajar();
  return b;
}

function adjunto(icono, titulo, sub) {
  const a = el('div', { class: 'adj' }, el('span', {}, titulo, sub ? el('small', {}, sub) : null));
  a.dataset.icono = icono;
  return a;
}

function mostrarMensaje(m) {
  switch (m.tipo) {
    case 'imagen':
      return burbuja('bot', el('img', { src: m.url, alt: '' }), m.texto || null);
    case 'documento':
      return burbuja('bot', adjunto('📄', m.nombreArchivo), m.texto || null);
    case 'ubicacion':
      return burbuja('bot', el('a', { href: `https://maps.google.com/?q=${m.lat},${m.lng}`, target: '_blank', rel: 'noopener' },
        adjunto('📍', m.nombre || 'Ubicación', m.direccion || `${m.lat}, ${m.lng}`)));
    case 'contacto':
      return burbuja('bot', adjunto('👤', m.nombre, m.telefono));
    case 'encuesta':
      return burbuja('bot', el('b', {}, m.texto), el('div', { class: 'encuesta' }, ...m.opciones.map(o =>
        el('button', { type: 'button', onclick: () => { $('#tInput').value = o; $('#composer').requestSubmit(); } }, o))));
    default:
      return burbuja('bot', ...formatoWhatsApp(m.texto), m.opciones?.length ? el('div', { class: 'encuesta' }, ...m.opciones.map(o =>
        el('button', { type: 'button', onclick: () => { $('#tInput').value = o; $('#composer').requestSubmit(); } }, o))) : null);
  }
}

// *negrita* y _cursiva_ como los muestra WhatsApp
function formatoWhatsApp(texto) {
  const partes = [];
  let ultimo = 0;
  for (const m of texto.matchAll(/(\*|_)([^*_\n]+)\1/g)) {
    partes.push(texto.slice(ultimo, m.index), el(m[1] === '*' ? 'b' : 'i', {}, m[2]));
    ultimo = m.index + m[0].length;
  }
  partes.push(texto.slice(ultimo));
  return partes;
}

function etiquetaFuente(res) {
  if (res.fuente === 'opcion' && nodo(res.respuestaId)) {
    const ir = el('button', { type: 'button', onclick: () => { mostrarSeccion('respuestas'); seleccionar(res.respuestaId); } }, rutaDe(res.respuestaId));
    return [`${FUENTES.opcion}: `, ir];
  }
  return [FUENTES[res.fuente] || res.fuente];
}

function reiniciarChat(avisarServer = true) {
  if (avisarServer && botId) api('POST', `/api/bots/${botId}/probar`, { reiniciar: true, sesion: sesionPrueba }).catch(() => {});
  sesionPrueba = nuevaSesion();
  chat.replaceChildren();
  estadoPrueba = null;
  renderArbol();
}

$('#composer').onsubmit = async e => {
  e.preventDefault();
  const input = $('#tInput');
  const texto = input.value.trim();
  if (!texto || !botId) return;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  burbuja('yo', texto);
  const esperando = burbuja('bot escribiendo', el('i'), el('i'), el('i'));
  $('#tEstado').textContent = 'escribiendo…';
  try {
    await guardarPendiente();
    const res = await api('POST', `/api/bots/${botId}/probar`, { texto, sesion: sesionPrueba });
    esperando.remove();
    res.mensajes.forEach(mostrarMensaje);
    (res.acciones || []).forEach(a => burbuja(`accion${a.ok ? '' : ' fallo'}`, `${a.ok ? '⚙' : '⚠'} ${a.detalle}`));
    chat.append(el('div', { class: 'fuente' }, ...etiquetaFuente(res)));
    estadoPrueba = res.respuestaId || res.nodoActual;
    renderArbol();
  } catch (err) {
    esperando.className = 'msg bot';
    esperando.textContent = `No pude responder: ${err.message}`;
  }
  $('#tEstado').textContent = 'en línea';
  bajar();
};

$('#tReset').onclick = () => reiniciarChat();

// Cursor propio: el nativo no deja cambiarle el alto
{
  const input = $('#tInput'), caret = $('#tCaret');
  const ctx = document.createElement('canvas').getContext('2d');
  const mover = () => {
    const sel = input.selectionStart === input.selectionEnd;
    caret.hidden = document.activeElement !== input || !sel;
    if (caret.hidden) return;
    ctx.font = getComputedStyle(input).font;
    const x = ctx.measureText(input.value.slice(0, input.selectionStart)).width - input.scrollLeft;
    caret.style.left = `${input.offsetLeft + Math.min(x, input.clientWidth)}px`;
    caret.style.animation = 'none'; caret.offsetWidth; caret.style.animation = '';
  };
  ['input', 'keyup', 'click', 'focus', 'blur', 'select'].forEach(ev => input.addEventListener(ev, mover));
  document.addEventListener('selectionchange', () => document.activeElement === input && mover());
}

/* ---------- Inicio ---------- */
$('#salir').onclick = async () => {
  await guardarPendiente();
  await fetch('/auth/salir', { method: 'POST' });
  location.href = '/login.html';
};

/* ---------- Integraciones (cuenta de Google del dueño) ---------- */
async function pintarGoogle(error = '') {
  const g = await api('GET', '/api/google').catch(() => ({ conectado: false }));
  const faltan = g.conectado && !g.sheets;
  $('#googleEstado').textContent = error || (g.conectado
    ? `Conectada como ${g.email}${faltan ? '. Faltan permisos: volvé a conectarla.' : '. Las planillas de las acciones se crean en su Drive.'}`
    : 'Conectala para que las acciones puedan escribir en planillas de Google Sheets.');
  $('#googleEstado').classList.toggle('mal', !!error || faltan);
  $('#googleConectar').textContent = g.conectado ? 'Volver a conectar' : 'Conectar Google';
  $('#googleDesconectar').hidden = !g.conectado;
  // Al conectar o desconectar Google cambian las planillas disponibles
  planillasCache = null;
  planillasError = '';
}
$('#googleConectar').onclick = async () => { await guardarPendiente(); location.href = '/auth/google/conectar'; };
$('#googleDesconectar').onclick = async () => { await api('POST', '/api/google/desconectar'); pintarGoogle(); };

async function iniciar() {
  const yo = await api('GET', '/api/yo');
  $('#usuario').title = yo.email;
  $('#usuarioNombre').textContent = yo.nombre || yo.email;
  if (yo.foto) $('#usuarioFoto').src = yo.foto;
  bots = await api('GET', '/api/bots');
  const porUrl = new URLSearchParams(location.search).get('bot');
  const pedido = porUrl || leer('botId');
  const id = bots.find(b => b.id === pedido)?.id || bots[0]?.id;
  const google = new URLSearchParams(location.search).get('google');
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  pintarGoogle(google === 'error' ? 'No se pudo conectar la cuenta de Google. Probá de nuevo.' : '');
  const sec = location.hash.slice(1);
  mostrarSeccion(sec);
  prepararDescarga();
  revisarServidor();
  // Con una sección en la URL se vuelve al agente en el que estaba; si no, arranca en el inicio
  if (id) await abrirBot(id);
  else await crearAgente();
}

iniciar();
