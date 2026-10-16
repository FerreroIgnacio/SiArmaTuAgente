import * as g from './google.js';
import { db } from './store.js';

// Las planillas viven en D1 (tabla planillas): el agente escribe ahí sin pedir nada a Google.
// Si el dueño quiere, se sincroniza con una Sheet de su Drive (drive.file) y cada fila nueva se replica ahí.
// Las planillas viejas que están solo en Drive (ids sin prefijo loc_) siguen andando por google.js.
const MAX_FILAS = 5000, MAX_CELDA = 2000, HOJA = 'Hoja 1';
const esLocal = id => /^loc_\w+$/.test(id);

async function cargar(sub, id) {
  const f = await db().prepare('SELECT datos FROM planillas WHERE id = ?1 AND dueno = ?2').bind(id, String(sub)).first();
  if (!f) throw new Error('La planilla no existe');
  return JSON.parse(f.datos);
}
const guardar = (sub, id, p) =>
  db().prepare('UPDATE planillas SET datos = ?3, modificada = ?4 WHERE id = ?1 AND dueno = ?2')
    .bind(id, String(sub), JSON.stringify(p), Date.now()).run();

// En local no hay fórmulas: el ' que antepone acciones.js para neutralizarlas sobra
const texto = v => String(v ?? '').replace(/^'(?=[=+\-@\t\r])/, '').slice(0, MAX_CELDA);
const hojaDe = (p, hoja) => (p.hojas[hoja] ? hoja : Object.keys(p.hojas)[0]);

export async function crearPlanilla(sub, { titulo, encabezados = [] }) {
  const id = `loc_${crypto.randomUUID().replace(/-/g, '')}`;
  const ahora = Date.now();
  const p = { nombre: titulo || 'Agente', creada: ahora, hojas: { [HOJA]: encabezados.length ? [encabezados.map(texto)] : [] }, drive: null };
  await db().prepare('INSERT INTO planillas (id, dueno, datos, modificada) VALUES (?1, ?2, ?3, ?4)').bind(id, String(sub), JSON.stringify(p), ahora).run();
  return { id, url: id, hoja: HOJA };
}

const resumen = (id, p, modificada) => ({
  id, nombre: p.nombre, url: id, local: true, sincronizada: !!p.drive, enlace: p.drive?.url || '',
  modificada: new Date(modificada).toISOString(), creada: new Date(p.creada).toISOString(),
});

export async function listarPlanillas(sub) {
  const { results = [] } = await db().prepare('SELECT id, datos, modificada FROM planillas WHERE dueno = ?').bind(String(sub)).all();
  const locales = results.map(f => resumen(f.id, JSON.parse(f.datos), f.modificada));
  const vinculadas = new Set(locales.map(p => g.idPlanilla(p.enlace)));
  // Planillas anteriores que solo existen en Drive (si no hay Google conectado, no hay ninguna)
  const drive = await g.listarPlanillas(sub).then(ps => ps.filter(p => !vinculadas.has(p.id)).map(p => ({ ...p, enlace: p.url })), () => []);
  return [...locales, ...drive].sort((a, b) => String(b.modificada).localeCompare(a.modificada));
}

// Cada dueño tiene al menos una planilla
export async function asegurarPlanilla(sub) {
  if (!(await listarPlanillas(sub)).length) await crearPlanilla(sub, { titulo: 'Registros del agente' });
}

export async function borrarPlanilla(sub, id) {
  id = g.idPlanilla(id);
  if (!esLocal(id)) return g.borrarPlanilla(sub, id);
  // La copia en Drive, si hay, no se toca
  await db().prepare('DELETE FROM planillas WHERE id = ?1 AND dueno = ?2').bind(id, String(sub)).run();
}

export async function hojasDe(sub, planilla) {
  const id = g.idPlanilla(planilla);
  return esLocal(id) ? Object.keys((await cargar(sub, id)).hojas) : g.hojasDe(sub, id);
}

export async function vistaPrevia(sub, planilla, hoja, filas = 20) {
  const id = g.idPlanilla(planilla);
  if (!esLocal(id)) return g.vistaPrevia(sub, id, hoja, filas);
  const p = await cargar(sub, id);
  hoja = hojaDe(p, hoja);
  return { hojas: Object.keys(p.hojas), hoja, filas: p.hojas[hoja].slice(0, filas) };
}

export async function agregarFila(sub, { planilla, hoja, columnas }) {
  const id = g.idPlanilla(planilla);
  if (!esLocal(id)) return g.agregarFila(sub, { planilla: id, hoja, columnas });
  const p = await cargar(sub, id);
  const h = hojaDe(p, hoja);
  if (p.hojas[h].length >= MAX_FILAS) throw new Error(`La planilla llegó al máximo de ${MAX_FILAS} filas`);
  const fila = [];
  for (const { columna, valor } of columnas) fila[g.letraANumero(columna) - 1] = texto(valor);
  p.hojas[h].push(Array.from(fila, v => v ?? ''));
  await guardar(sub, id, p);
  if (p.drive) await g.agregarFila(sub, { planilla: p.drive.id, hoja: p.drive.hoja, columnas }).catch(err => console.error('Sync Drive:', err.message));
}

export async function actualizarFila(sub, args) {
  const id = g.idPlanilla(args.planilla);
  if (!esLocal(id)) return g.actualizarFila(sub, { ...args, planilla: id });
  const { hoja, buscarColumna, buscarValor, columnas, crear } = args;
  const p = await cargar(sub, id);
  const h = hojaDe(p, hoja), filas = p.hojas[h];
  const col = g.letraANumero(buscarColumna) - 1;
  const norm = v => String(v ?? '').trim().toLowerCase();
  const i = filas.findIndex(f => norm(f[col]) === norm(buscarValor));
  let res;
  if (i < 0) {
    if (!crear) return { encontrada: false };
    if (filas.length >= MAX_FILAS) throw new Error(`La planilla llegó al máximo de ${MAX_FILAS} filas`);
    const fila = [];
    for (const { columna, valor } of [{ columna: buscarColumna, valor: buscarValor }, ...columnas]) fila[g.letraANumero(columna) - 1] = texto(valor);
    filas.push(Array.from(fila, v => v ?? ''));
    res = { encontrada: false, agregada: true };
  } else {
    for (const { columna, valor } of columnas) {
      const c = g.letraANumero(columna) - 1;
      while (filas[i].length < c) filas[i].push('');
      filas[i][c] = texto(valor);
    }
    res = { encontrada: true, fila: i + 1 };
  }
  await guardar(sub, id, p);
  if (p.drive) await g.actualizarFila(sub, { ...args, planilla: p.drive.id, hoja: p.drive.hoja }).catch(err => console.error('Sync Drive:', err.message));
  return res;
}

// Crea la copia en Drive con lo que ya tiene la planilla; desde ahí las filas nuevas se replican
export async function sincronizarDrive(sub, planilla) {
  const id = g.idPlanilla(planilla);
  if (!esLocal(id)) throw new Error('Esta planilla ya está en Drive');
  const p = await cargar(sub, id);
  if (p.drive) return { url: p.drive.url };
  const d = await g.crearPlanilla(sub, { titulo: p.nombre });
  const valores = p.hojas[Object.keys(p.hojas)[0]];
  if (valores.length) await g.escribirValores(sub, d.id, d.hoja, valores);
  p.drive = { id: d.id, url: d.url, hoja: d.hoja };
  await guardar(sub, id, p);
  return { url: d.url };
}
