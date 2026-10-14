import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import path from 'node:path';

// App de escritorio del agente local: levanta el servidor de src/local y lo muestra en su propia ventana.
const { DATOS } = await import('../local/env.js');

// Una sola instancia por agente: dos abiertas responderían dos veces el mismo WhatsApp
app.setPath('userData', path.join(DATOS, 'app'));
if (!app.requestSingleInstanceLock()) app.exit(0);

const ICONO = path.join(import.meta.dirname, '../../build/icon.png');

let ventana = null;
app.on('second-instance', () => {
  if (!ventana) return;
  if (ventana.isMinimized()) ventana.restore();
  ventana.focus();
});
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    const { arrancar } = await import('../local/main.js');
    const { url, nombre } = await arrancar();
    ventana = new BrowserWindow({
      width: 1120, height: 780, minWidth: 720, minHeight: 520,
      title: `${nombre} · Si`, icon: ICONO, backgroundColor: '#faf8f6', show: false,
    });
    // Los links de afuera (SiSoftwareSolutions.com, las planillas) se abren en el navegador del sistema
    ventana.webContents.setWindowOpenHandler(({ url: destino }) => { shell.openExternal(destino); return { action: 'deny' }; });
    ventana.webContents.on('will-navigate', (e, destino) => {
      if (destino.startsWith(url)) return;
      e.preventDefault();
      shell.openExternal(destino);
    });
    ventana.once('ready-to-show', () => ventana.show());
    await ventana.loadURL(url);
  } catch (err) {
    dialog.showErrorBox('No se pudo abrir tu agente', err.message);
    app.exit(1);
  }
});
