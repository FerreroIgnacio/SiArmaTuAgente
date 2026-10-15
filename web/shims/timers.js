// Los timers de Node tienen unref()/ref(); en el navegador son números. Number envuelto: clearTimeout lo sigue aceptando
for (const nombre of ['setTimeout', 'setInterval']) {
  const original = globalThis[nombre];
  globalThis[nombre] = (...args) => Object.assign(new Number(original(...args)), { unref() { return this; }, ref() { return this; }, hasRef: () => true, refresh() { return this; } });
}
