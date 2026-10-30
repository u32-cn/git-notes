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
  } else if (pathname === '/api/bind/probe' && method === 'POST') {
    out = await git.bindProbe(body ? body.remote : '');
  } else if (pathname === '/api/bind/confirm' && method === 'POST') {
    busyGuard();
    out = await git.enqueueWrite(() => git.bindConfirm(body ? body.remote : ''));
  } else if (pathname === '/api/bind/merge' && method === 'POST') {
    busyGuard();
    out = await git.enqueueWrite(() => git.bindMerge());
  } else if (pathname === '/api/bind/force-push' && method === 'POST') {
    busyGuard();
    out = await git.enqueueWrite(() => git.bindForcePush());
  } else if (pathname === '/api/bind/cancel' && method === 'POST') {
    busyGuard();
    out = await git.enqueueWrite(() => git.cancelBind());
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

module.exports = { handleApi, handleAiProxy, setOpenRepo, setUpdateInstaller, setUpdateRunner, setUpdateProgress, VERSION, checkUpdate };
