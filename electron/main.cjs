const { app, BrowserWindow, dialog, nativeImage } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const port = 3102;
const appUrl = process.env.LOCAL_APP_URL || `http://127.0.0.1:${port}`;
const nodePath = process.env.LOCAL_APP_NODE_PATH || 'node';
const testMode = process.env.LOCAL_APP_TEST_MODE === '1';
const testHoldMs = Math.max(100, Number(process.env.LOCAL_APP_TEST_HOLD_MS || 100));
const logPath = process.env.LOCAL_APP_LOG || path.join(projectRoot, '.runtime', 'logs', 'multiple-file-date-time-editor-latest.log');

let mainWindow = null;
let serverProcess = null;
let serverLog = null;
let quitting = false;

app.setName('Multiple File Date Time Editor');

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady()
  .then(async () => {
    await ensureServer();
    await createWindow();
  })
  .catch((error) => {
    dialog.showErrorBox('Multiple File Date Time Editor 실행 오류', error.message);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => dialog.showErrorBox('창 열기 오류', error.message));
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopServer);

async function createWindow() {
  const icon = loadSvgIcon(path.join(projectRoot, 'public', 'favicon.svg'));
  mainWindow = new BrowserWindow({
    title: 'Multiple File Date Time Editor',
    width: 1420,
    height: 980,
    minWidth: 900,
    minHeight: 720,
    show: !testMode,
    backgroundColor: '#eef1f5',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) event.preventDefault();
  });
  await mainWindow.loadURL(appUrl);

  if (testMode) {
    const bridgeReady = await mainWindow.webContents.executeJavaScript(
      'Boolean(window.desktopFiles?.getPathForFile)',
      true,
    );
    if (!bridgeReady) throw new Error('파일 드롭 브리지를 불러오지 못했습니다.');
    console.log('desktop-smoke-test passed');
    setTimeout(() => app.quit(), testHoldMs);
  }
}

async function ensureServer() {
  const existing = await fetchHealth();
  if (existing) {
    if (Number(existing.apiVersion) < 3 || existing.features?.desktopFileDrop !== true) {
      throw new Error('3102번 포트에서 이전 버전 서버가 실행 중입니다. 기존 창을 닫고 다시 실행해 주세요.');
    }
    return;
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  serverLog = fs.createWriteStream(logPath, { flags: 'a' });
  serverProcess = spawn(nodePath, ['scripts/start-production.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.pipe(serverLog);
  serverProcess.stderr.pipe(serverLog);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`서버가 종료 코드 ${serverProcess.exitCode}로 끝났습니다. 로그: ${logPath}`);
    }
    const health = await fetchHealth();
    if (health?.ok && Number(health.apiVersion) >= 3 && health.features?.desktopFileDrop === true) return;
    await delay(200);
  }
  throw new Error(`서버가 제시간에 시작되지 않았습니다. 로그: ${logPath}`);
}

async function fetchHealth() {
  try {
    const response = await fetch(`${appUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function stopServer() {
  if (quitting) return;
  quitting = true;
  if (serverProcess?.pid && serverProcess.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(serverProcess.pid), '/T', '/F'], { windowsHide: true });
    } else {
      serverProcess.kill('SIGTERM');
    }
  }
  if (serverLog) serverLog.end();
}

function loadSvgIcon(iconPath) {
  try {
    const svg = fs.readFileSync(iconPath);
    return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${svg.toString('base64')}`);
  } catch {
    return undefined;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
