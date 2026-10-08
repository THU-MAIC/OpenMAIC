'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEV_URL = process.env.OPENMAIC_DESKTOP_URL || 'http://localhost:3000';
const isDev = process.argv.includes('--dev') || Boolean(process.env.OPENMAIC_DESKTOP_URL);
const serverPort = Number(process.env.OPENMAIC_DESKTOP_PORT || 3210);
const desktopSyncToken = process.env.OPENMAIC_DESKTOP_SYNC_TOKEN || randomBytes(32).toString('hex');

let mainWindow;
let serverProcess;
let localUrl;

const hasSingleInstanceLock = app.requestSingleInstanceLock();

function canOpenInApp(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function waitForHttp(url, timeoutMs = 120_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };

    attempt();
  });
}

async function startBundledServer() {
  const serverRoot = path.join(process.resourcesPath, 'openmaic-server');
  const serverEntry = path.join(serverRoot, 'server.js');

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: serverRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(serverPort),
      NODE_PATH: path.join(serverRoot, 'runtime-modules'),
      OPENMAIC_DATA_DIR: path.join(app.getPath('userData'), 'data'),
      COOKIE_SECURE: '0',
      OPENMAIC_DESKTOP_SYNC_ENABLED: '1',
      OPENMAIC_DESKTOP_SYNC_TOKEN: desktopSyncToken,
      OPENMAIC_PUBLIC_SKILLS_DIRS: JSON.stringify([
        path.join(os.homedir(), '.codex', 'skills'),
        path.join(os.homedir(), '.agents', 'skills'),
      ]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const collect = (chunk) => {
    output += chunk.toString();
    if (output.length > 10_000) output = output.slice(-10_000);
  };
  serverProcess.stdout.on('data', collect);
  serverProcess.stderr.on('data', collect);
  serverProcess.once('error', (error) => console.error('[openmaic] bundled server error', error));
  serverProcess.once('exit', (code, signal) => {
    if (code !== 0 && !app.isQuitting) {
      console.error(`[openmaic] bundled server exited (${code ?? signal})\n${output}`);
    }
  });

  localUrl = `http://127.0.0.1:${serverPort}`;
  await waitForHttp(localUrl);
  return localUrl;
}

function installDesktopSyncCredential(url) {
  const endpoint = new URL('/api/desktop-sync', url).toString();
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${endpoint}*`] },
    (details, callback) => {
      details.requestHeaders['X-OpenMAIC-Desktop-Sync'] = desktopSyncToken;
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#ffffff',
    title: 'OpenMAIC',
    // The page paints the 32px title bar; Electron keeps the native controls.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 9 } }
      : {
          titleBarOverlay: { color: '#00000000', symbolColor: '#64748b', height: 32 },
        }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (!canOpenInApp(targetUrl)) void shell.openExternal(targetUrl);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!canOpenInApp(targetUrl)) {
      event.preventDefault();
      void shell.openExternal(targetUrl);
    }
  });
  void mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

async function boot() {
  await app.whenReady();
  app.setAsDefaultProtocolClient('openmaic');

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  ipcMain.handle('open-external', async (_event, url) => {
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return false;
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });

  try {
    const url = isDev ? DEV_URL : await startBundledServer();
    localUrl = url;
    installDesktopSyncCredential(url);
    createWindow(url);
  } catch (error) {
    console.error('[openmaic] desktop startup failed', error);
    await dialog.showMessageBox({
      type: 'error',
      title: 'OpenMAIC 启动失败',
      message: '无法启动 OpenMAIC 本地服务。',
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow && localUrl) createWindow(localUrl);
  });

  void boot();
}
