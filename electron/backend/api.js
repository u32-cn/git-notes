// API 路由：签名 (method, pathname, query, body) → { status, payload }。
// 纯单机内部调用：无 cookie、无 Host 校验、无鉴权（与 web/server.js 的差异，见 AGENTS.md）。
// 路由语义对齐 web/server.js（改动 server.js 路由时需手工同步本文件）。

'use strict';
const fs = require('fs');
const path = require('path');

const store = require('./store');
const git = require('./git');

const VERSION = require('../package.json').version;

/* 打开本地仓库文件夹：由 main.js 注入 Electron shell.openPath（backend 不 require electron） */
let openRepoImpl = null;
function setOpenRepo(fn) { openRepoImpl = fn; }

/* 一键更新：由 main.js 注入（updateInstaller 触发后台检测→下载到 ready 即止不弹框；
   updateRunner 由用户点击「安装」后执行静默安装并退出），backend 只负责路由入口。
   立即返回不阻塞响应——下载在 main 进程异步进行 */
let updateInstaller = null;
function setUpdateInstaller(fn) { updateInstaller = fn; }
let updateRunner = null;
function setUpdateRunner(fn) { updateRunner = fn; }
/* 下载进度读取器：main.js 注入（phase ∈ idle|checking|downloading|ready，received/total 字节），backend 只透传 */
let updateProgressGetter = null;
function setUpdateProgress(fn) { updateProgressGetter = fn; }
function getUpdateProgress() {
  return (updateProgressGetter && updateProgressGetter()) || { active: false, phase: 'idle', percent: 0, received: 0, total: 0, latest: '', error: '' };
}

/* 检测新版本：读 OSS 更新源 update/win/latest.yml（version 行），与 package.json 版本比对。
   8s 超时；任何失败（网络/格式）都不抛错，装进 error 字段由前端展示 */
const UPDATE_BASE = 'https://u32.cn/bd/apps/git-notes/update';
/* 语义化比较：latest 逐段数值大于 current 才算有新版（更新源过期/回滚时不得误报） */
function isNewerVersion(latest, current) {
  const a = String(latest).split('.').map(n => parseInt(n, 10) || 0);
  const b = String(current).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
async function checkUpdate() {
  try {
    const r = await fetch(UPDATE_BASE + '/win/latest.yml', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('更新源 HTTP ' + r.status);
    const text = await r.text();
    const m = text.match(/^version:\s*(\S+)/m);
    if (!m) throw new Error('更新源格式异常');
    const latest = m[1];
    /* electron-builder latest.yml 的 sha512 为 base64 形式，供安装包完整性校验/免重下复用 */
    const s = text.match(/^sha512:\s*(\S+)/m);
    return {
      supported: true,
      current: VERSION,
      latest,
      updateAvailable: isNewerVersion(latest, VERSION),
      url: UPDATE_BASE + '/win/git-notes-' + latest + '-setup.exe',
      sha512: s ? s[1] : '',
    };
  } catch (e) {
    return { supported: true, current: VERSION, latest: null, updateAvailable: false, url: '', error: String((e && e.message) || e) };
  }
}

async function openRepo() {
  if (!git.hasRepo()) throw store.appError(409, '本地仓库尚未初始化');
  if (!openRepoImpl) throw store.appError(500, '打开器未初始化');
  const err = await openRepoImpl(store.REPO_DIR);
  if (err) throw store.appError(500, '无法打开文件夹：' + err);
  return { ok: true, path: store.REPO_DIR };
}

function busyGuard() {
  if (git.syncState.busy || git.isWriteBusy()) throw store.appError(409, '同步或写入进行中');
}

async function route(method, pathname, query, body) {
  if (!pathname.startsWith('/api/')) throw store.appError(404, 'not found');
  let out = null;
  if (pathname === '/api/status') {
    out = {
      version: VERSION,
      stage: git.stage(),
      platform: process.platform,
      remote: store.getConfig().remote || '',
      branch: git.hasRepo() ? store.MAIN_BRANCH : '',
      key: { exists: fs.existsSync(store.KEY_FILE), pubKey: fs.existsSync(store.PUB_FILE) ? fs.readFileSync(store.PUB_FILE, 'utf8').trim() : '' },
      clone: { active: git.cloneState.active, phase: git.cloneState.phase, progress: git.cloneState.progress, error: git.cloneState.error },
      sync: { busy: git.syncState.busy || git.isWriteBusy(), phase: git.syncState.phase, lastError: git.syncState.lastError, conflict: git.syncState.conflict, lastAt: git.syncState.lastAt, ahead: git.syncState.ahead, behind: git.syncState.behind },
    };
  } else if (pathname === '/api/setup/local' && method === 'POST') {
    out = await git.setupLocal();
  } else if (pathname === '/api/setup/key' && method === 'POST') {
    out = { pubKey: await git.ensureKey() };
  } else if (pathname === '/api/setup/key/rotate' && method === 'POST') {
    out = await git.rotateKey();
  } else if (pathname === '/api/setup/key/import' && method === 'POST') {
    out = await git.importKey(body ? body.privateKey : '');
  } else if (pathname === '/api/setup/key/private' && method === 'POST') {
    out = git.readPrivateKey();
  } else if (pathname === '/api/setup/clone' && method === 'POST') {
    out = await git.startClone(body ? body.remote : '');
  } else if (pathname === '/api/bind/connect' && method === 'POST') {
    out = await git.enqueueWrite(() => git.bindConnect(body ? body.remote : ''));
  } else if (pathname === '/api/unbind' && method === 'POST') {
    out = await git.unbind();
  } else if (pathname === '/api/sync' && method === 'POST') {
    busyGuard();
    out = await git.doSync();
  } else if (pathname === '/api/repo/open' && method === 'POST') {
    out = await openRepo();
  } else if (pathname === '/api/force-push' && method === 'POST') {
    busyGuard();
    out = await git.enqueueWrite(() => git.forcePush());
  } else if (pathname === '/api/remote-overwrite' && method === 'POST') {
    busyGuard();
    out = await git.enqueueWrite(() => git.remoteOverwrite());
  } else if (pathname === '/api/posts' && method === 'GET') {
    git.ensureReady();
    out = store.pagePosts(query.get('before') || '');
  } else if (pathname === '/api/posts' && method === 'POST') {
    if (git.syncState.busy || git.isWriteBusy()) throw store.appError(409, '已有写操作进行中，请稍候');
    out = await git.enqueueWrite(() => git.writePost(body));
  } else if (pathname === '/api/posts' && method === 'PUT') {
    if (git.syncState.busy || git.isWriteBusy()) throw store.appError(409, '已有写操作进行中，请稍候');
    out = await git.enqueueWrite(() => git.updatePost(body));
  } else if (pathname === '/api/posts/pin' && method === 'POST') {
    if (git.syncState.busy || git.isWriteBusy()) throw store.appError(409, '已有写操作进行中，请稍候');
    out = await git.enqueueWrite(() => git.setPin({ path: body ? body.path : '', pinned: !!(body && body.pinned) }));
  } else if (pathname === '/api/posts' && method === 'DELETE') {
    if (git.syncState.busy || git.isWriteBusy()) throw store.appError(409, '已有写操作进行中，请稍候');
    out = await git.enqueueWrite(() => git.deletePost(body));
  } else if (pathname === '/api/tags' && method === 'GET') {
    git.ensureReady();
    out = { tags: store.readTags() };
  } else if (pathname === '/api/tags' && method === 'PUT') {
    if (git.syncState.busy || git.isWriteBusy()) throw store.appError(409, '已有写操作进行中，请稍候');
    out = await git.enqueueWrite(() => git.writeTags(body.tags, body.action, body.tag));
  } else if (pathname === '/api/search' && method === 'GET') {
    git.ensureReady();
    out = store.searchAll(query.get('q') || '');
  } else if (pathname === '/api/git/log' && method === 'GET') {
    git.ensureReady();
    out = await git.gitLog({ limit: query.get('limit'), path: query.get('path') || '' });
  } else if (pathname === '/api/git/show' && method === 'GET') {
    git.ensureReady();
    out = await git.gitShow({ path: query.get('path') || '', commit: query.get('commit') || '' });
  } else if (pathname === '/api/git/restore' && method === 'POST') {
    busyGuard();
    out = await git.enqueueWrite(() => git.gitRestore(body));
  } else if (pathname === '/api/update/check' && method === 'GET') {
    out = await checkUpdate();
  } else if (pathname === '/api/update/install' && method === 'POST') {
    if (!updateInstaller) throw store.appError(409, '更新器未初始化');
    updateInstaller();
    out = { ok: true };
  } else if (pathname === '/api/update/run' && method === 'POST') {
    if (!updateRunner) throw store.appError(409, '安装器未初始化');
    updateRunner();
    out = { ok: true };
  } else if (pathname === '/api/update/progress' && method === 'GET') {
    out = getUpdateProgress();
  } else if (pathname === '/api/ai/settings' && method === 'GET') {
    out = git.readAiSettings();
  } else if (pathname === '/api/ai/settings' && method === 'POST') {
    busyGuard();
    out = await git.enqueueWrite(() => git.setAiSettings(git.validAiConfig(body)));
  } else if (pathname === '/api/ai/providers' && method === 'GET') {
    out = await aiProviders();
  } else if (pathname === '/api/http/request' && method === 'POST') {
    out = await httpRequestTool(body);
  } else if (pathname === '/api/web/search' && method === 'POST') {
    out = await webSearchTool(body);
  } else if (pathname === '/api/fs/list' && method === 'GET') {
    out = git.fsList(query.get('path') || '');
  } else if (pathname === '/api/fs/read' && method === 'GET') {
    out = git.fsRead(query.get('path') || '');
  } else if (pathname === '/api/fs/write' && method === 'POST') {
    out = await git.fsWrite(body);
  } else if (pathname === '/api/fs/delete' && method === 'POST') {
    out = await git.fsDelete(body);
  } else if (pathname === '/api/fs/move' && method === 'POST') {
    out = await git.fsMove(body);
  } else if (pathname === '/api/fs/mkdir' && method === 'POST') {
    out = await git.fsMkdir(body);
  } else if (pathname === '/api/git/status' && method === 'GET') {
    out = await git.gitStatus();
  } else if (pathname === '/api/git/add' && method === 'POST') {
    out = await git.gitAdd(body);
  } else if (pathname === '/api/git/commit' && method === 'POST') {
    out = await git.gitCommit(body);
  } else if (pathname === '/api/git/push' && method === 'POST') {
    out = await git.gitPush();
  } else if (pathname === '/api/git/pull' && method === 'POST') {
    out = await git.gitPull();
  } else if (pathname === '/api/git/diff' && method === 'GET') {
    out = await git.gitDiff({ from: query.get('from') || '', to: query.get('to') || '', path: query.get('path') || '', mode: query.get('mode') || '' });
  } else if (pathname === '/api/git/branch' && method === 'POST') {
    out = await git.gitBranchOp(body);
  } else if (pathname === '/api/git/restore-files' && method === 'POST') {
    out = await git.gitRestoreFiles(body);
  } else {
    throw store.appError(404, 'not found');
  }
  return out;
}

/* 完整请求处理（含错误到 status/payload 的映射），供 main.js 的协议 handler 调用 */
async function handleApi(method, pathname, query, body) {
  try {
    const out = await route(method, pathname, query, body);
    return { status: 200, payload: out };
  } catch (e) {
    const status = e.status || 500;
    const payload = { error: String(e.message || e) };
    if (e.conflict) payload.conflict = e.conflict;
    if (e.needPubKey) payload.needPubKey = true;
    return { status, payload };
  }
}

/* AI 提供商预设：远端 JSON（OSS 托管，可随时更新）→ 内存缓存；拉取失败/不合法回退内置清单。
   对齐 web/server.js aiProviders（前端 CSP 不放宽，由本地端代理读取）。 */
const AI_PROVIDERS_URL = 'https://u32.cn/bd/apps/git-notes/info/mode_providers.json';
const BUILTIN_AI_PROVIDERS = [
  { id: 'zhipu-free', label: '智谱免费（glm-4.7-flash，免费但不稳定，开放平台 key）', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', keyLink: 'https://bigmodel.cn/apikey/platform', extra: { thinking: { type: 'disabled' } } },
  { id: 'zhipu-fast', label: '智谱快速（glm-5.3-flash，开放平台 key）', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', keyLink: 'https://bigmodel.cn/apikey/platform', extra: { thinking: { type: 'disabled' } } },
  { id: 'zhipu-coding', label: '智谱编程套餐快速（glm-5.3-flash，Coding 套餐 key）', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3-flash', keyLink: 'https://bigmodel.cn/apikey/platform', extra: { thinking: { type: 'disabled' } } },
  { id: 'deepseek', label: '深度求索（deepseek-flash，极速）', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', keyLink: 'https://platform.deepseek.com/api_keys', extra: { thinking: { type: 'disabled' } } },
  { id: 'custom', label: '自定义大模型（手动填写）', baseURL: '', model: '', keyLink: '' },
];
function validProvider(p) {
  return {
    id: String(p.id || '').trim().slice(0, 40),
    label: String(p.label || '').trim().slice(0, 100),
    baseURL: String(p.baseURL || '').trim().replace(/\/+$/, '').slice(0, 300),
    model: String(p.model || '').trim().slice(0, 100),
    keyLink: String(p.keyLink || '').trim().slice(0, 300),
    extra: p.extra && typeof p.extra === 'object' && !Array.isArray(p.extra) ? p.extra : null,
  };
}
let aiProvidersCache = { okAt: 0, failAt: 0, data: null };
async function aiProviders() {
  const now = Date.now();
  if (aiProvidersCache.data && now - aiProvidersCache.okAt < 3600e3) return aiProvidersCache.data;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(AI_PROVIDERS_URL, { signal: ctl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const j = JSON.parse(await r.text());
      const providers = Array.isArray(j.providers) ? j.providers.map(validProvider).filter((p) => p.id && p.label) : [];
      if (providers.length) {
        aiProvidersCache = { okAt: now, failAt: 0, data: { version: 1, builtin: false, providers } };
        return aiProvidersCache.data;
      }
    }
  } catch (_) { /* 离线/坏 JSON 走兜底 */ }
  if (aiProvidersCache.data && aiProvidersCache.data.builtin && now - aiProvidersCache.failAt < 300e3) return aiProvidersCache.data;
  aiProvidersCache = { okAt: 0, failAt: now, data: { version: 1, builtin: true, providers: BUILTIN_AI_PROVIDERS.slice() } };
  return aiProvidersCache.data;
}

/* AI 代理：浏览器统一经本进程转发 AI 请求并透传流式响应（对齐 web/server.js aiProxy）。
   由 main.js 在协议层直接调用（绕过 JSON 路由，返回 Response）；url/key 来自本机页面 localStorage，不落日志。 */
async function handleAiProxy(req) {
  let payload;
  try {
    payload = await req.json();
  } catch (_) {
    return jsonResponse(400, { error: 'JSON 解析失败' });
  }
  const target = String((payload && payload.url) || '');
  if (!/^https?:\/\//.test(target) || target.length > 2000) return jsonResponse(400, { error: 'url 非法' });
  let up;
  try {
    up = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String((payload && payload.key) || ''), 'Accept-Encoding': 'identity' },
      body: JSON.stringify((payload && payload.body) || {})
    });
  } catch (e) {
    return jsonResponse(502, { error: '上游连接失败：' + e.message });
  }
  return new Response(up.body, {
    status: up.status,
    headers: { 'Content-Type': up.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}
function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

/* ================= 通用 HTTP 请求端点（AI 工具 http_request / web_fetch 的服务端执行器） =================
   对齐 web/server.js httpRequestTool（改动需手工同步两端）：
   本进程 fetch 无 CORS；手动跟随重定向并对每跳校验主机，拒绝内网地址（防 SSRF）；
   响应按 max_bytes 截断整体读入，字符集按 Content-Type 解码（GBK 站点转 gb18030）。 */

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const HTTP_DEFAULT_MAX = 512 * 1024;
const HTTP_LIMIT_MAX = 5 * 1024 * 1024;

function httpPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;   /* 组播/保留段 */
  }
  if (h === '::' || h === '::1' || /^f[ce]/.test(h) || /^fe[89ab]/.test(h)) return true;   /* IPv6 回环/ULA/链路本地 */
  return false;
}

function httpPickCharset(contentType) {
  const m = /charset=([\w-]+)/i.exec(String(contentType || ''));
  const name = m ? m[1].toLowerCase() : '';
  return (name === 'gbk' || name === 'gb2312' || name === 'gb18030') ? 'gb18030' : (name || 'utf-8');
}

async function httpReadCapped(stream, maxBytes) {
  if (!stream) return { buf: Buffer.alloc(0), truncated: false };
  const chunks = [];
  let total = 0, truncated = false;
  try {
    for await (const c of stream) {
      chunks.push(c);
      total += c.length;
      if (total >= maxBytes) { truncated = true; break; }
    }
  } catch (_) { /* 中途断开：返回已读部分 */ }
  return { buf: Buffer.concat(chunks).subarray(0, maxBytes), truncated };
}

async function httpRequestTool(body) {
  const urlStr = String((body && body.url) || '').trim();
  if (!/^https?:\/\//i.test(urlStr) || urlStr.length > 2000) throw store.appError(400, 'url 非法（仅支持 http/https）');
  const method = String((body && body.method) || 'GET').toUpperCase();
  if (HTTP_METHODS.indexOf(method) === -1) throw store.appError(400, 'method 不支持：' + method);
  const timeoutMs = Math.min(Math.max(Number(body && body.timeout_ms) || 20000, 1000), 60000);
  const maxBytes = Math.min(Math.max(Number(body && body.max_bytes) || HTTP_DEFAULT_MAX, 1024), HTTP_LIMIT_MAX);
  const wantB64 = (body && body.encoding) === 'base64';
  const rawHeaders = (body && body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) ? body.headers : {};
  const reqHeaders = {};
  Object.keys(rawHeaders).slice(0, 30).forEach((k) => {
    const name = String(k).replace(/[^\x21-\x7e]/g, '');
    const value = String(rawHeaders[k] == null ? '' : rawHeaders[k]).replace(/[\r\n]/g, '').slice(0, 4000);
    /* 逐跳头由 fetch 自己管理，禁止伪造 */
    if (name && !/^(host|content-length|connection|transfer-encoding|upgrade)$/i.test(name)) reqHeaders[name] = value;
  });
  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) > -1 && body && body.body != null;
  const bodyStr = hasBody ? String(body.body) : undefined;
  if (bodyStr !== undefined && !reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'text/plain; charset=utf-8';

  let current = urlStr, redirects = 0, res = null;
  while (true) {
    let u;
    try { u = new URL(current); } catch (_) { throw store.appError(400, 'url 解析失败：' + current); }
    if (httpPrivateHost(u.hostname)) throw store.appError(400, '拒绝访问内网地址：' + u.hostname);
    try {
      res = await fetch(current, {
        method: method,
        headers: reqHeaders,
        body: bodyStr,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw store.appError(502, '请求失败：' + ((e && e.message) || e));
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try { if (res.body) res.body.cancel(); } catch (_) {}
      if (++redirects > 5) throw store.appError(508, '重定向次数超限（>5）');
      try { current = new URL(loc, current).href; } catch (_) { throw store.appError(400, '重定向地址非法：' + loc); }
      continue;
    }
    break;
  }

  const contentType = res.headers.get('content-type') || '';
  const { buf, truncated } = await httpReadCapped(res.body, maxBytes);
  const charset = httpPickCharset(contentType);
  let text, encoding;
  try {
    const dec = new TextDecoder(charset);
    text = dec.decode(buf);
    encoding = 'text';
  } catch (_) {
    text = buf.toString('base64');
    encoding = 'base64';
  }
  if (wantB64 && encoding === 'text' && !/^text\/|json|xml|javascript|html/i.test(contentType)) {
    text = buf.toString('base64');
    encoding = 'base64';
  }
  return {
    status: res.status,
    content_type: contentType,
    size: buf.length,
    truncated: truncated,
    final_url: current,
    encoding: encoding,
    text: text,
  };
}

module.exports = { handleApi, handleAiProxy, setOpenRepo, setUpdateInstaller, setUpdateRunner, setUpdateProgress, VERSION, checkUpdate };

/* ================= 联网搜索端点（AI 工具 web_search 的服务端执行器） =================
   对齐 web/server.js webSearchTool（改动需手工同步两端）：
   转发 Firecrawl Search API，默认匿名（keyless），api_key 时附 Bearer 头；
   恒返回 200 JSON：{ ok:true, auth, results } 或 { ok:false, quota_exceeded, error }。 */

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';
const FIRECRAWL_KEY_URL = 'https://www.firecrawl.dev';

async function webSearchTool(body) {
  const q = String((body && body.query) || '').trim();
  if (!q || q.length > 500) return { ok: false, quota_exceeded: false, error: 'query 必填且不超过 500 字符' };
  const reqBody = { query: q, limit: Math.min(Math.max(Number(body && body.limit) || 5, 1), 10) };
  ['lang', 'country', 'tbs'].forEach((k) => {
    const v = String((body && body[k]) || '').trim();
    if (v) reqBody[k] = v.slice(0, 20);
  });
  const key = String((body && body.api_key) || '').trim().slice(0, 200);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;

  let res;
  try {
    res = await fetch(FIRECRAWL_SEARCH_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, quota_exceeded: false, error: '搜索服务连接失败：' + ((e && e.message) || e) };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const quota = res.status === 402 || res.status === 429;
    return {
      ok: false,
      quota_exceeded: quota,
      key_url: FIRECRAWL_KEY_URL,
      error: quota ? '搜索配额不足（HTTP ' + res.status + '）' : '搜索失败：HTTP ' + res.status + (data && data.error ? '：' + data.error : ''),
    };
  }
  const web = (data && data.data && data.data.web) || [];
  return {
    ok: true,
    auth: key ? 'api-key' : 'keyless',
    results: web.slice(0, 10).map((r) => ({ url: String(r.url || ''), title: String(r.title || ''), description: String(r.description || '') })),
  };
}
