import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const isDev = process.argv.includes('--dev') || process.env.NODE_ENV !== 'production';
const shouldOpenChrome = process.argv.includes('--open-chrome');
const shouldOpenBrowser = process.argv.includes('--open') || shouldOpenChrome;
const port = Number(process.env.PORT || 3102);
const host = process.env.HOST || '127.0.0.1';
const app = express();
const previewFiles = new Map();
const previewIdsByPath = new Map();

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    apiVersion: 3,
    platform: process.platform,
    features: { desktopFileDrop: true },
  });
});

app.get('/api/files/preview/:id', async (req, res) => {
  const filePath = previewFiles.get(req.params.id);
  if (!filePath) {
    res.status(404).end();
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      res.status(404).end();
      return;
    }
    if (isTransportStream(filePath)) {
      streamTranscodedPreview(req, res, filePath);
      return;
    }
    const range = req.headers.range;
    const contentType = previewContentType(filePath);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', contentType);
    if (!range) {
      res.setHeader('Content-Length', stat.size);
      fsSync.createReadStream(filePath).pipe(res);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }
    let start;
    let end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      start = Math.max(0, stat.size - suffixLength);
      end = stat.size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : stat.size - 1;
      end = Math.min(end, stat.size - 1);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fsSync.createReadStream(filePath, { start, end }).pipe(res);
  } catch (error) {
    if (!res.headersSent) res.status(error?.code === 'ENOENT' ? 404 : 500).end();
  }
});

app.post('/api/files/choose', async (_req, res) => {
  try {
    if (process.platform !== 'win32') {
      res.status(501).json({ error: '현재 파일 선택 기능은 Windows에서 지원됩니다.' });
      return;
    }
    const filePaths = await chooseWindowsFiles();
    if (!filePaths.length) {
      res.json({ cancelled: true });
      return;
    }
    if (filePaths.length > 500) {
      throw new Error('한 번에 500개 이하의 파일을 선택하세요.');
    }
    const files = await Promise.all(filePaths.map(fileInfo));
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({ files });
  } catch (error) {
    res.status(statusFor(error)).json({ error: userMessage(error) });
  }
});

app.post('/api/files/resolve', async (req, res) => {
  try {
    const requestedPaths = Array.isArray(req.body?.filePaths) ? req.body.filePaths : [];
    if (requestedPaths.length < 1 || requestedPaths.length > 500) {
      throw new Error('한 번에 1개 이상 500개 이하의 파일을 놓아 주세요.');
    }

    const seen = new Set();
    const filePaths = [];
    for (const value of requestedPaths) {
      const filePath = path.resolve(String(value || '').trim());
      const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
      if (seen.has(key)) continue;
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`${path.basename(filePath)}은(는) 파일이 아닙니다.`);
      seen.add(key);
      filePaths.push(filePath);
    }
    res.json({ files: await Promise.all(filePaths.map(fileInfo)) });
  } catch (error) {
    res.status(statusFor(error)).json({ error: userMessage(error) });
  }
});

app.post('/api/files/dates', async (req, res) => {
  try {
    if (process.platform !== 'win32') {
      res.status(501).json({ error: '만든 날짜 변경은 현재 Windows에서 지원됩니다.' });
      return;
    }

    const requestedPaths = Array.isArray(req.body?.filePaths) ? req.body.filePaths : [];
    if (requestedPaths.length < 1 || requestedPaths.length > 500) {
      throw new Error('한 번에 1개 이상 500개 이하의 파일을 선택하세요.');
    }
    const filePaths = requestedPaths.map((value) => path.resolve(String(value || '').trim()));
    const createdAt = normalizeLocalDate(req.body?.createdAt, '만든 날짜');
    const modifiedAt = normalizeLocalDate(req.body?.modifiedAt, '수정한 날짜');
    const autoIncrement = req.body?.autoIncrement === true;
    const intervalMs = Number(req.body?.intervalMs);
    if (autoIncrement && (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 86400000)) {
      throw new Error('증가 간격은 1~86,400,000 밀리초 사이의 정수로 입력하세요.');
    }

    for (const filePath of filePaths) {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`${path.basename(filePath)}은(는) 파일이 아닙니다.`);
    }

    const createdStartMs = parseLocalDate(createdAt).getTime();
    const modifiedStartMs = parseLocalDate(modifiedAt).getTime();
    for (let index = 0; index < filePaths.length; index += 1) {
      const offset = autoIncrement ? index * intervalMs : 0;
      await setWindowsFileDates(
        filePaths[index],
        toLocalInputValue(new Date(createdStartMs + offset)),
        toLocalInputValue(new Date(modifiedStartMs + offset)),
      );
    }
    res.json({ files: await Promise.all(filePaths.map(fileInfo)) });
  } catch (error) {
    res.status(statusFor(error)).json({ error: userMessage(error) });
  }
});

app.post('/api/files/timeline', async (req, res) => {
  try {
    if (process.platform !== 'win32') {
      res.status(501).json({ error: '만든 날짜 변경은 현재 Windows에서 지원됩니다.' });
      return;
    }

    const entries = Array.isArray(req.body?.files) ? req.body.files : [];
    if (entries.length < 1 || entries.length > 500) {
      throw new Error('한 번에 1개 이상 500개 이하의 파일을 선택하세요.');
    }

    const normalized = [];
    const seen = new Set();
    for (const entry of entries) {
      const filePath = path.resolve(String(entry?.filePath || '').trim());
      const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
      if (seen.has(key)) throw new Error('같은 파일이 목록에 중복되어 있습니다.');
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`${path.basename(filePath)}은(는) 파일이 아닙니다.`);
      normalized.push({
        filePath,
        createdAt: normalizeLocalDate(entry?.createdAt, '만든 날짜'),
        modifiedAt: normalizeLocalDate(entry?.modifiedAt, '수정한 날짜'),
      });
      seen.add(key);
    }

    await setWindowsFileTimeline(normalized);
    res.json({ files: await Promise.all(normalized.map((entry) => fileInfo(entry.filePath))) });
  } catch (error) {
    res.status(statusFor(error)).json({ error: userMessage(error) });
  }
});

if (isDev) {
  const vite = await import('vite');
  const viteServer = await vite.createServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(viteServer.middlewares);
} else {
  app.use(express.static(path.join(rootDir, 'dist')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(rootDir, 'dist', 'index.html'));
  });
}

app.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`파일 날짜 변경 도구가 실행 중입니다: ${url}`);
  if (shouldOpenBrowser) openBrowser(url, { preferChrome: shouldOpenChrome });
});

async function fileInfo(filePath) {
  const stat = await fs.stat(filePath);
  const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
  let previewId = previewIdsByPath.get(key);
  if (!previewId) {
    previewId = randomUUID();
    previewIdsByPath.set(key, previewId);
    previewFiles.set(previewId, filePath);
  }
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    createdAt: toLocalInputValue(stat.birthtime),
    modifiedAt: toLocalInputValue(stat.mtime),
    previewId,
    canPreview: /\.(ts|m2ts|mp4|m4v|mov|webm|ogv)$/i.test(filePath),
  };
}

function previewContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.ts' || extension === '.m2ts') return 'video/mp2t';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.ogv') return 'video/ogg';
  if (extension === '.mov') return 'video/quicktime';
  return 'video/mp4';
}

function isTransportStream(filePath) {
  return /\.(ts|m2ts)$/i.test(filePath);
}

function streamTranscodedPreview(req, res, filePath) {
  if (!ffmpegPath) {
    res.status(500).json({ error: '이 컴퓨터에서 FFmpeg 미리보기 실행 파일을 찾지 못했습니다.' });
    return;
  }

  const child = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-vf', "scale=w='min(1280,iw)':h=-2",
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '27',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let responseStarted = false;
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-3000);
  });
  child.stdout.once('data', (chunk) => {
    responseStarted = true;
    res.status(200);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Preview-Transcoded', 'true');
    res.write(chunk);
    child.stdout.pipe(res);
  });
  child.stdout.on('end', () => {
    if (!responseStarted && !res.headersSent) {
      res.status(422).json({ error: `FFmpeg가 이 TS 파일을 변환하지 못했습니다. ${stderr.trim().slice(-500)}` });
    }
  });
  child.on('error', (error) => {
    if (!res.headersSent) res.status(500).json({ error: `FFmpeg를 실행하지 못했습니다. ${error.message}` });
    else res.destroy(error);
  });
  child.on('close', (code) => {
    if (code !== 0 && responseStarted && !res.writableEnded) {
      res.destroy(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
    }
  });
  res.on('close', () => {
    if (!res.writableEnded && child.exitCode === null) child.kill();
  });
}

function normalizeLocalDate(value, label) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) throw new Error(`${label} 형식이 올바르지 않습니다.`);

  const [, year, month, day, hour, minute, second = '00', fraction = '0'] = match;
  const millisecond = fraction.padEnd(3, '0');
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
  const valid = date.getFullYear() === Number(year)
    && date.getMonth() === Number(month) - 1
    && date.getDate() === Number(day)
    && date.getHours() === Number(hour)
    && date.getMinutes() === Number(minute)
    && date.getSeconds() === Number(second)
    && date.getMilliseconds() === Number(millisecond);
  if (!valid) throw new Error(`${label}에 실제 존재하는 날짜와 시각을 입력하세요.`);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}`;
}

function toLocalInputValue(date) {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
    '.',
    pad(date.getMilliseconds(), 3),
  ].join('');
}

function parseLocalDate(value) {
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [clock, fraction = '0'] = timePart.split('.');
  const [hour, minute, second] = clock.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0')));
}

function chooseWindowsFiles() {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "날짜를 변경할 파일 선택"',
    '$dialog.Filter = "모든 파일 (*.*)|*.*"',
    '$dialog.Multiselect = $true',
    '$dialog.CheckFileExists = $true',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  [Console]::Write(($dialog.FileNames | ConvertTo-Json -Compress))',
    '}',
  ].join('\n');
  return runPowerShell(script).then((output) => {
    if (!output) return [];
    const parsed = JSON.parse(output.replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

function setWindowsFileDates(filePath, createdAt, modifiedAt) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$culture = [Globalization.CultureInfo]::InvariantCulture',
    '$style = [Globalization.DateTimeStyles]::None',
    '$format = "yyyy-MM-ddTHH:mm:ss.fff"',
    '$created = [DateTime]::ParseExact($env:FDT_CREATED, $format, $culture, $style)',
    '$modified = [DateTime]::ParseExact($env:FDT_MODIFIED, $format, $culture, $style)',
    '[IO.File]::SetCreationTime($env:FDT_PATH, $created)',
    '[IO.File]::SetLastWriteTime($env:FDT_PATH, $modified)',
  ].join('\n');

  return runPowerShell(script, {
    FDT_PATH: filePath,
    FDT_CREATED: createdAt,
    FDT_MODIFIED: modifiedAt,
  }).then(() => undefined);
}

function setWindowsFileTimeline(entries) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$culture = [Globalization.CultureInfo]::InvariantCulture',
    '$style = [Globalization.DateTimeStyles]::None',
    '$format = "yyyy-MM-ddTHH:mm:ss.fff"',
    '$jsonBase64 = [Console]::In.ReadToEnd()',
    '$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($jsonBase64))',
    '$entries = $json | ConvertFrom-Json',
    'try {',
    '  foreach ($entry in $entries) {',
    '    try {',
    '      $created = [DateTime]::ParseExact($entry.createdAt, $format, $culture, $style)',
    '      $modified = [DateTime]::ParseExact($entry.modifiedAt, $format, $culture, $style)',
    '      [IO.File]::SetCreationTime($entry.filePath, $created)',
    '      [IO.File]::SetLastWriteTime($entry.filePath, $modified)',
    '    } catch {',
    '      throw "$($entry.filePath): $($_.Exception.Message)"',
    '    }',
    '  }',
    '} catch {',
    '  $errorBytes = [Text.Encoding]::UTF8.GetBytes($_.Exception.Message)',
    '  [Console]::Out.WriteLine("FDT_ERROR:" + [Convert]::ToBase64String($errorBytes))',
    '  exit 1',
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const output = Buffer.concat(stdout).toString('utf8').trim();
        const encodedError = output.match(/(?:^|\r?\n)FDT_ERROR:([A-Za-z0-9+/=]+)(?:\r?\n|$)/);
        const errorMessage = encodedError
          ? Buffer.from(encodedError[1], 'base64').toString('utf8')
          : Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(errorMessage || 'Windows 파일 날짜를 변경하지 못했습니다.'));
      }
    });
    const encodedEntries = Buffer.from(JSON.stringify(entries), 'utf8').toString('base64');
    child.stdin.end(encodedEntries, 'ascii');
  });
}

function runPowerShell(script, extraEnv = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      if (code === 0) resolve(output);
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || 'Windows 파일 정보를 변경하지 못했습니다.'));
    });
  });
}

function openBrowser(url, { preferChrome = false } = {}) {
  if (preferChrome) {
    const chromePath = findWindowsChrome();
    if (chromePath) {
      spawnDetached(chromePath, ['--new-tab', url]);
      return;
    }
  }
  spawnDetached('cmd.exe', ['/c', 'start', '', url]);
}

function findWindowsChrome() {
  const candidates = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ]
    .filter(Boolean)
    .map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || '';
}

function spawnDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

function statusFor(error) {
  return error?.code === 'ENOENT' ? 404 : 400;
}

function userMessage(error) {
  if (!error) return '알 수 없는 오류가 발생했습니다.';
  if (error.code === 'ENOENT') return '파일을 찾을 수 없습니다. 다시 선택해 주세요.';
  if (error.code === 'EACCES' || error.code === 'EPERM') return '파일을 변경할 권한이 없습니다. 파일이 사용 중인지도 확인해 주세요.';
  return error.message || String(error);
}
