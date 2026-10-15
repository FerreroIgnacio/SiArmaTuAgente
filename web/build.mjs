// Bundle de Baileys para el navegador → public/wa-worker.js
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeModulesPolyfillPlugin } from 'esbuild-plugins-node-modules-polyfill';

const dir = path.dirname(fileURLToPath(import.meta.url));

// fs → memfs, ws → WebSocket nativo
const shims = {
  name: 'shims',
  setup(b) {
    b.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: path.join(dir, 'shims/fs.js') }));
    b.onResolve({ filter: /^(node:)?fs\/promises$/ }, () => ({ path: path.join(dir, 'shims/fs-promises.js') }));
    b.onResolve({ filter: /^ws$/ }, () => ({ path: path.join(dir, 'shims/ws.js') }));
    b.onResolve({ filter: /^(node:)?async_hooks$/ }, () => ({ path: path.join(dir, 'shims/async_hooks.js') }));
    b.onResolve({ filter: /^(node:)?assert$/ }, () => ({ path: path.join(dir, 'shims/assert.cjs') }));
  },
};

// Ajustes puntuales a Baileys para que use el camino de navegador
const parches = {
  name: 'parches-baileys',
  setup(b) {
    b.onLoad({ filter: /baileys[\\/]lib[\\/]Utils[\\/]messages-media\.js$/ }, async a => {
      let src = await readFile(a.path, 'utf8');
      const reemplazar = (de, a) => { if (!src.includes(de)) throw new Error(`Parche no aplica: ${de}`); src = src.replace(de, a); };
      // Con el polyfill de process, Baileys se cree en Node
      reemplazar('const isNodeRuntime = () => {', 'const isNodeRuntime = () => false; const _isNodeRuntime = () => {');
      // Subida: el archivo cifrado (en memoria) va entero en el body, sin streams de Node
      reemplazar('const webStream = Readable.toWeb(nodeStream);', 'nodeStream.destroy(); const webStream = await fs.readFile(filePath);');
      reemplazar("duplex: 'half',", '');
      // Descargas (historial, media): el fromWeb del polyfill está incompleto; se lee el ReadableStream a mano
      reemplazar('Readable.fromWeb(response.body)', 'Readable.from((async function* (r) { for (;;) { const { done, value } = await r.read(); if (done) return; yield Buffer.from(value); } })(response.body.getReader()))');
      return { contents: src, loader: 'js' };
    });
  },
};

await build({
  entryPoints: [path.join(dir, 'wa-worker.js')],
  outfile: path.join(dir, '../public/wa-worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  // Opcionales de Baileys (miniaturas, previews de links): si no están, los saltea
  external: ['jimp', 'sharp', 'link-preview-js', 'audio-decode', 'qrcode-terminal'],
  plugins: [shims, parches, nodeModulesPolyfillPlugin({ globals: { Buffer: true, process: true }, fallback: 'empty' })],
  logLevel: 'warning',
});
