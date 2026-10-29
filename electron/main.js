// Git笔记 Electron 桌面版主进程。
// 纯单机架构：零端口、零 HTTP、零鉴权——gnapp:// 自定义协议 + 进程内原生后端（backend/）。
// index.html 构建时从 ../web/ 拷入 build/（npm start / npm run dist 自动执行），前端零分叉。

'use strict';
const { app, BrowserWindow, protocol, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const backend = require('./backend/api');
const git = require('./backend/git');
const store = require('./backend/store');

const INDEX = path.join(__dirname, 'build', 'index.html');

/* 冒烟隔离：GN_SMOKE_USERDATA 指定独立 userData（不与用户正在运行的实例抢单实例锁，也不动其窗口） */
if (process.env.GN_SMOKE_USERDATA) {
  app.setPath('userData', process.env.GN_SMOKE_USERDATA);
}

/* 必须在 app.ready 之前注册：standard 使相对路径 fetch('/api/...') 正确解析，
   supportFetchAPI 放行页面 fetch，stream 供媒体流式响应 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'gnapp', privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true } },
]);

/* 单实例：多个窗口写同一个 ~/.git-notes 仓库有并发风险，二次启动聚焦已有窗口 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/* CSP：与 web/server.js 同规则——前端拆分为 assets/js 静态文件后，脚本样式放行同源（self）。
   style-src 保留 unsafe-inline：页面仍用 style 属性与 JS 内联样式 */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

const BUILD = path.join(__dirname, 'build');
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
/* 静态文件（仅 assets/ 与 js/ 两个白名单目录，防目录穿越） */
function serveStatic(pathname) {
  const rel = decodeURIComponent(pathname.slice(1));
  if (!/^(assets|js)\/[A-Za-z0-9._-]+$/.test(rel)) return null;
  const abs = path.join(BUILD, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return new Response(fs.readFileSync(abs), {
    status: 200,
    headers: {
      'Content-Type': STATIC_TYPES[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  });
}

function jsonOf(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* gnapp://app/<path> → 进程内处理 */
async function handleGnapp(req) {
  const u = new URL(req.url);
  const pathname = u.pathname;
  const method = req.method;
  try {
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return new Response(fs.readFileSync(INDEX), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' },
      });
    }
    if (method === 'GET' && pathname === '/help.html') {
      /* 帮助独立页：静态文档不调 API、无 cookie 需求，仍带 CSP（对齐 web/server.js） */
      return new Response(fs.readFileSync(path.join(BUILD, 'help.html')), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' },
      });
    }
    if (method === 'GET' && (pathname.startsWith('/assets/') || pathname.startsWith('/js/'))) {
      const r = serveStatic(pathname);
      if (r) return r;
      return jsonOf(404, { error: 'not found' });
    }
    if (pathname === '/__hard-reload') {
      /* 信息流「同步并刷新」按钮触发：整页忽略缓存重载（含 /media 的 1h 图片缓存） */
      const win = BrowserWindow.getAllWindows()[0];
      if (win) setImmediate(() => win.webContents.reloadIgnoringCache());
      return new Response('reloading', { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
    if (pathname === '/healthz') {
      return jsonOf(200, { ok: true, version: backend.VERSION, pid: process.pid });
    }
    if (pathname.startsWith('/media/') && method === 'GET') {
      const rel = decodeURIComponent(pathname.slice('/media/'.length));
      if (!/^micro\/[A-Za-z0-9._/\-]+$/.test(rel) || rel.includes('..')) return jsonOf(400, { error: '非法路径' });
      const abs = path.join(store.REPO_DIR, rel);
      if (!abs.startsWith(path.join(store.REPO_DIR, 'micro') + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return jsonOf(404, { error: 'not found' });
      }
      const ext = (rel.match(/\.([a-zA-Z0-9]+)$/) || [])[1].toLowerCase();
      const diskName = rel.split('/').pop();
      const headers = { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
      if (store.IMG_MIME[ext]) {
        headers['Content-Type'] = store.IMG_MIME[ext];   /* 图片维持内联（卡片/灯箱 <img> 依赖） */
      } else {
        /* 非图片一律 attachment 下载：防同源 html/svg 执行，nosniff 防 MIME 嗅探（对齐 web/server.js） */
        headers['Content-Type'] = store.FILE_MIME[ext] || 'application/octet-stream';
        headers['Content-Disposition'] = 'attachment; filename="' + diskName.replace(/[^A-Za-z0-9._-]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(diskName);
      }
      return new Response(fs.readFileSync(abs), { status: 200, headers });
    }
    if (pathname === '/api/ai/proxy' && method === 'POST') {
      return backend.handleAiProxy(req);   // 流式透传，绕过 JSON 路由
    }
    if (pathname.startsWith('/api/')) {
      let body = null;
      if (['POST', 'PUT', 'DELETE'].includes(method)) {
        const buf = Buffer.from(await req.arrayBuffer());
        /* 上限 300MB（9 图 + 9 附件 base64 极端场景），对齐 server.js readBody */
        if (buf.length > 300 * 1024 * 1024) return jsonOf(413, { error: '请求体过大' });
        /* 空请求体按空对象处理（/api/sync、/api/repo/open 等无体 POST 依赖此语义） */
        if (buf.length) {
          try { body = JSON.parse(buf.toString('utf8')); } catch (_) { return jsonOf(400, { error: 'JSON 解析失败' }); }
        } else {
          body = {};
        }
      }
      const { status, payload } = await backend.handleApi(method, pathname, u.searchParams, body);
      return jsonOf(status, payload);
    }
    return jsonOf(404, { error: 'not found' });
  } catch (e) {
    console.error('[gnapp]', pathname, e && (e.stack || e.message || e));
    return jsonOf(500, { error: String(e.message || e) });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    autoHideMenuBar: true,
    title: 'Git笔记',
    icon: path.join(__dirname, 'icons', 'icon.ico'),
    backgroundColor: '#f7f6f2',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('gnapp://app/index.html');
  /* F12 / Ctrl+Shift+I 切换 DevTools（应用自身调试用，不开端口） */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const f12 = input.key === 'F12';
    const ctrlShiftI = input.control && input.shift && (input.key === 'I' || input.key === 'i');
    if (f12 || ctrlShiftI) {
      e.preventDefault();
      const wc = win.webContents;
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' });
    }
  });
  /* 引导页平台直达链接（Gitee/GitHub/Codeup 等）：外链一律交系统浏览器，不开应用内窗口；
     help.html（帮助文档）放行为应用内子窗口（gnapp:// 纯本地，零端口红线不破坏） */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^gnapp:\/\/app\/help\.html$/i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 760, height: 860, autoHideMenuBar: true, title: 'Git笔记 · 帮助' },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* 自动更新（方案 C，纯本机行为，无端口/服务）：
   后台检测 → 下载到 userData/update/（目录内最多保留一个安装包）→ 置 ready 即止，绝不自动弹框；
   renderer 轮询 /api/update/progress 看到 ready 后把进度 UI 变成「点击安装」，
   用户点击才 POST /api/update/run 拉起 NSIS 静默安装（/S，覆盖安装并自动拉起新版），当前实例退出。
   免重下：下载前先查 update 目录是否已有目标版本安装包且 sha512 与更新源一致，命中直接 ready；
   未命中则清空目录再下（旧版本包不留）。sha512 取 latest.yml（electron-builder 为 base64 形式）。
   下载先写 .part、成功后改名——防中断残留半截 exe 被当完整包；检测/下载失败静默置 error。
   在途守卫：启动自动检测与顶栏按钮点击可能并发，同时只跑一套。
   进度状态供 renderer 轮询（GET /api/update/progress）：phase ∈ idle|checking|downloading|ready|none */
let updating = false;
const updateProgress = { active: false, phase: 'idle', percent: 0, received: 0, total: 0, latest: '', error: '', file: '' };
function setProgress(patch) { Object.assign(updateProgress, patch); }
function updateDir() { return path.join(app.getPath('userData'), 'update'); }
/* sha512 校验：want 为 latest.yml 的 base64 值；缺失（旧源/校验失败取不到）时返回 false 以触发重下 */
function sha512Match(file, wantB64) {
  if (!wantB64) return false;
  try {
    return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64') === wantB64;
  } catch (_) { return false; }
}
async function autoUpdate() {
  if (updating) return;
  updating = true;
  setProgress({ active: true, phase: 'checking', percent: 0, received: 0, total: 0, latest: '', error: '', file: '' });
  try {
    const r = await backend.checkUpdate();
    if (!r.updateAvailable || !r.url) { setProgress({ active: false, phase: 'none', latest: r.latest || '' }); return; }
    setProgress({ phase: 'downloading', latest: r.latest });
    const dir = updateDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'git-notes-' + r.latest + '-setup.exe');
    /* 目录里已有目标版本且校验通过 → 免重下；否则清空目录（最多保留一个安装包）再下 */
    if (!sha512Match(dest, r.sha512)) {
      for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
      const part = dest + '.part';
      const res = await fetch(r.url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
      if (!res.ok) { setProgress({ active: false, phase: 'idle', error: '更新源 HTTP ' + res.status }); return; }
      const total = Number(res.headers.get('content-length')) || 0;
      setProgress({ total, received: 0, percent: 0 });
      let received = 0;
      /* res.body 是 web ReadableStream（无 .on），先 fromWeb 包成 Node 流再挂进度监听 */
      const src = Readable.fromWeb(res.body);
      src.on('data', (chunk) => {
        received += chunk.length;
        setProgress({ received, total, percent: total ? Math.min(100, Math.round(received * 100 / total)) : 0 });
      });
      try {
        await pipeline(src, fs.createWriteStream(part));
        fs.renameSync(part, dest);
      } catch (e) {
        try { fs.unlinkSync(part); } catch (_) {}
        throw e;
      }
      if (!sha512Match(dest, r.sha512)) throw new Error('安装包校验失败（sha512 不符）');
    }
    setProgress({ phase: 'ready', percent: 100, file: dest });
  } catch (e) {
    console.error('[update]', e && (e.message || e));
    setProgress({ active: false, phase: 'idle', error: String((e && e.message) || e) });
  } finally {
    updating = false;
    setProgress({ active: false });
  }
}
/* 用户在 UI 点「安装」后执行：校验 ready 态与安装包存在，spawn NSIS 静默安装并退出当前实例 */
function runInstall() {
  if (updateProgress.phase !== 'ready' || !updateProgress.file || !fs.existsSync(updateProgress.file)) {
    throw store.appError(409, '安装包尚未就绪，请先下载');
  }
  spawn(updateProgress.file, ['/S'], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

app.whenReady().then(async () => {
  /* 前置拦截：后端依赖系统 git（server.js 同款 checkGitAvailable），缺失时提示后退出 */
  const ok = await git.checkGitAvailable();
  if (!ok) {
    dialog.showErrorBox('Git笔记', '未检测到 git。请安装 Git for Windows（含 ssh-keygen）并确认在 PATH 中，然后重新启动。');
    app.quit();
    return;
  }
  /* 打开仓库文件夹走 Electron shell（替代 server.js 的 spawn explorer） */
  backend.setOpenRepo((p) => shell.openPath(p));
  /* 顶栏一键更新按钮：renderer POST /api/update/install 触发后台检测→下载（到 ready 即止，不弹框）；
     renderer POST /api/update/run 在 ready 后经用户点击执行静默安装；
     /api/update/progress 由 renderer 轮询读下载进度 */
  backend.setUpdateInstaller(() => { autoUpdate(); });
  backend.setUpdateRunner(() => { runInstall(); });
  backend.setUpdateProgress(() => ({ ...updateProgress }));
  protocol.handle('gnapp', handleGnapp);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  /* 方案 B 自动更新：打包版启动 15s 后后台跑，避免抢首屏；开发态与冒烟隔离实例不跑 */
  if (app.isPackaged && !process.env.GN_SMOKE_USERDATA) {
    setTimeout(autoUpdate, 15 * 1000);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
