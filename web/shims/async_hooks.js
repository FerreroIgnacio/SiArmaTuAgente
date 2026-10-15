// Sin AsyncLocalStorage en el navegador: Baileys escribe las claves directo en vez de agruparlas en transacciones
export class AsyncLocalStorage {
  getStore() { return undefined; }
  run(store, fn, ...args) { return fn(...args); }
}
