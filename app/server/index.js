import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const WINDOW_W = 1280;
const WINDOW_H = 820;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// 本次运行的状态
const state = {
  source: null, // { path, name, type, size }
  outputDir: '',
  suffix: '(A4)',
  env: {},
};

// 用户配置（记住上次选择的输出目录）
const CONFIG_FILE = path.join(os.homedir(), '.papersplit', 'config.json');

function loadUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function saveUserConfig(patch) {
  try {
    const cfg = { ...loadUserConfig(), ...patch };
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {}
}

function extMime(p) {
  return MIME[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function setSource(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  state.source = {
    path: filePath,
    name: path.basename(filePath),
    type: extMime(filePath),
    size: stat.size,
  };
  return state.source;
}

function resolveOutput(suggestedName, dirOverride) {
  const source = state.source;
  const dir = (dirOverride && dirOverride.trim())
    || state.outputDir
    || (source ? path.dirname(source.path) : '');
  if (!dir) return { error: '未设置输出目录，且未提供源文件' };

  let base;
  if (source) {
    base = path.parse(source.path).name + state.suffix;
  } else {
    const raw = path.basename(decodeURIComponent(suggestedName || 'output.pdf'));
    base = raw.replace(/\.pdf$/i, '');
  }
  let output = path.join(dir, base + '.pdf');
  if (source && path.resolve(output) === path.resolve(source.path)) {
    output = path.join(dir, base + '(A4).pdf');
  }
  return { output, dir };
}

// ---- 原生文件选择框（PowerShell） ----
function runPs(script) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `bm-paper-pick-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    try {
      fs.writeFileSync(tmp, '\ufeff' + script, 'utf8');
    } catch {
      resolve('');
      return;
    }
    const child = spawn(
      'powershell',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    const done = () => {
      try { fs.unlinkSync(tmp); } catch {}
      resolve(out);
    };
    child.on('error', done);
    child.on('close', done);
  });
}

async function pickFile() {
  const OWNER = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
`;
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${OWNER}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $false
$d.Filter = "试卷文件|*.pdf;*.jpg;*.jpeg;*.png|PDF 文件|*.pdf|图片文件|*.jpg;*.jpeg;*.png|所有文件|*.*"
$d.Title = "选择 A3 试卷或文档"
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($d.FileName)
}
$owner.Dispose()
`;
  const out = await runPs(script);
  const picked = out.trim();
  return picked || null;
}

async function pickDirectory() {
  const OWNER = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
`;
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${OWNER}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = "选择 A4 输出目录"
$d.ShowNewFolderButton = $true
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($d.SelectedPath)
}
$owner.Dispose()
`;
  const out = await runPs(script);
  const picked = out.trim();
  return picked || null;
}

// ---- 浏览器回退 ----
function findBrowser() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const la = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

function getCenterArgs() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output $b.Width; Write-Output $b.Height"',
      { encoding: 'utf-8', timeout: 5000, windowsHide: true }
    );
    const [sw, sh] = out.trim().split(/\r?\n/).map((s) => parseInt(s.trim(), 10));
    if (!sw || !sh) return [];
    const left = Math.max(0, Math.round((sw - WINDOW_W) / 2));
    const top = Math.max(0, Math.round((sh - WINDOW_H) / 2));
    return [`--window-position=${left},${top}`, `--window-size=${WINDOW_W},${WINDOW_H}`];
  } catch {
    return [`--window-size=${WINDOW_W},${WINDOW_H}`];
  }
}

function openBrowser(url, onClose) {
  const browser = findBrowser();
  if (!browser) {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return null;
  }
  const userDataDir = path.join(os.tmpdir(), 'bmscript-papersplit-profile');
  const proc = spawn(browser, [
    '--app=' + url,
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + userDataDir,
    ...getCenterArgs(),
  ]);
  proc.on('exit', onClose);
  return proc;
}

function openWindow(url, onClose) {
  const startedAt = Date.now();
  let settled = false;
  let webview;
  try {
    webview = spawn(
      'webview-cli',
      [url, '--title', 'A3试卷分割A4', '--width', String(WINDOW_W), '--height', String(WINDOW_H)],
      { stdio: 'ignore', windowsHide: false }
    );
  } catch {
    openBrowser(url, onClose);
    return;
  }
  webview.on('error', () => {
    if (settled) return;
    settled = true;
    openBrowser(url, onClose);
  });
  webview.on('exit', (code) => {
    if (settled) return;
    settled = true;
    const early = Date.now() - startedAt < 3000;
    if (code !== 0 && code !== 2 && early) {
      openBrowser(url, onClose);
      return;
    }
    onClose();
  });
}

// ---- 请求处理 ----
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': extMime(filePath), 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/state' && req.method === 'GET') {
    sendJson(res, 200, {
      bridge: true,
      invoke_mode: state.env.invoke_mode || 'manual',
      source: state.source,
      output: { dir: state.outputDir, suffix: state.suffix },
    });
    return;
  }

  if (pathname === '/api/input' && req.method === 'GET') {
    if (!state.source || !fs.existsSync(state.source.path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No input');
      return;
    }
    serveFile(res, state.source.path);
    return;
  }

  if (pathname === '/api/pick' && req.method === 'POST') {
    try {
      const picked = await pickFile();
      if (!picked) { sendJson(res, 200, { ok: false, cancelled: true }); return; }
      const source = setSource(picked);
      sendJson(res, 200, { ok: !!source, source });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (pathname === '/api/pick-dir' && req.method === 'POST') {
    try {
      const dir = await pickDirectory();
      if (!dir) { sendJson(res, 200, { ok: false, cancelled: true }); return; }
      state.outputDir = dir;
      saveUserConfig({ outputDir: dir });
      sendJson(res, 200, { ok: true, path: dir });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (pathname === '/api/save' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body || !body.length) { sendJson(res, 400, { ok: false, error: '空数据' }); return; }
      const dirHeader = req.headers['x-output-dir'];
      const dirOverride = dirHeader ? decodeURIComponent(String(dirHeader)).trim() : '';
      const target = resolveOutput(req.headers['x-filename'], dirOverride);
      if (target.error) { sendJson(res, 400, { ok: false, error: target.error }); return; }
      fs.mkdirSync(path.dirname(target.output), { recursive: true });
      fs.writeFileSync(target.output, body);
      if (dirOverride) {
        state.outputDir = dirOverride;
        saveUserConfig({ outputDir: dirOverride });
      }
      sendJson(res, 200, { ok: true, output: target.output });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(DIST, rel);
  if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, filePath);
}

export function start({ files = [], params = {}, env = {} } = {}) {
  applyConfig({ files, params, env });

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      try { sendJson(res, 500, { ok: false, error: e.message }); } catch {}
    });
  });

  const shutdown = () => {
    const done = () => process.exit(0);
    try {
      server.close(done);
    } catch {
      done();
      return;
    }
    // 兜底：连接未及时释放时强制退出
    setTimeout(done, 1500).unref();
  };

  server.on('error', (err) => {
    console.error('服务启动失败:', err.message);
    process.exit(1);
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    openWindow('http://127.0.0.1:' + port + '/', shutdown);
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export function applyConfig({ files = [], params = {}, env = {} } = {}) {
  const paramDir = (params.output_dir || '').trim();
  const savedDir = (loadUserConfig().outputDir || '').trim();
  state.outputDir = paramDir || savedDir;
  state.suffix = params.suffix != null ? String(params.suffix) : '(A4)';
  state.env = env || {};
  state.source = null;
  if (files.length > 0) setSource(files[0]);
}

export { handleRequest, DIST };
