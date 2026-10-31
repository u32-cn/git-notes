// Git笔记（git-notes）本地服务：本地 git 仓库架构
// 由 git-notes 全局命令后台托管；也可手动 node server.js。
//
// 两种模式：
// - 仅本机使用：git init 本地仓库，读写全在本地，不需要任何远端与密钥
// - 绑定远端：任意 git 服务器（地址用户自填），同步策略 rebase → merge → 冲突待处理
//   （冲突时页面提供「强制推送（本地为准）」；AI 分析处理为后续版本）
//
// 端口：环境变量 GN_PORT（默认 8644）；仅监听 127.0.0.1。
// 数据：~/.git-notes/{repo/,keys/,config.json}
// 依赖：无 npm 依赖（Node >= 18）；需系统 PATH 有 git（仅本机模式），SSH 远端另需 ssh-keygen。
// 安全：cookie（SameSite=Lax）+ Host 校验；日志不打印请求头、cookie 与查询串。

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const pinyin = require('./pinyin-data');
const charPinyin = pinyin.buildCharPinyin();

const VERSION = require('./package.json').version;
/* 构建溯源（AGENTS.md 规则：先提交再打包，包内 commit+时间可溯源）。
   web 端无构建：启动时读源码仓库（本文件上级目录）git 最新提交，内存缓存不落盘；
   electron/android 由构建脚本注入同名 assets/version.json，前端三端统一 GET /assets/version.json */
let APP_VERSION = { commit: '', time: '', subject: '' };
try {
  const src = require('child_process').execSync('git log -1 --format=%h%n%cI%n%s', {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim().split('\n');
  APP_VERSION = { commit: src[0] || '', time: src[1] || '', subject: src[2] || '' };
} catch (_) {}
const PORT = Number(process.env.GN_PORT) || 8644;
const HOST = '127.0.0.1';
const INDEX = path.join(__dirname, 'index.html');
const HOME_DIR = path.join(os.homedir(), '.git-notes');
const KEY_DIR = path.join(HOME_DIR, 'keys');
const KEY_FILE = path.join(KEY_DIR, 'id_ed25519');
const PUB_FILE = KEY_FILE + '.pub';
const KNOWN_HOSTS = path.join(KEY_DIR, 'known_hosts');
const REPO_DIR = path.join(HOME_DIR, 'repo');
const PAGE_TOKEN = crypto.randomBytes(24).toString('hex');

const DEFAULT_TAGS = ['待办', '已完成待办', '备忘', '日记', '杂记', '收藏', '想法', '感悟'];
const MAX_IMAGES = 9;
const MAX_FILES = 9;
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };
/* 非图片附件的 Content-Type 猜测表；不在表内一律 octet-stream，且 /media 直出统一 attachment 下载，防同源 html/svg 执行 */
const FILE_MIME = { pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', gz: 'application/gzip', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

/* ================= 配置（远端绑定的唯一事实源：repo/.git/config 的 origin） =================
   同一配置信息只存一份：git 层的 origin 由 git 命令（clone / remote add|remove）落盘，
   应用启动时解析一次入内存，此后绑定/解绑只改内存（磁盘已由对应 git 命令写好）。
   不再有 config.json——避免两处存储不一致导致的状态错乱（2026-10-28）。 */
function readOriginFromGitConfig() {
  try {
    const txt = fs.readFileSync(path.join(REPO_DIR, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(txt);
    return m ? m[1] : '';
  } catch (_) {
    return '';   /* repo 不存在（fresh）或尚无 origin（local） */
  }
}
function saveConfig(patch) {
  config = { ...config, ...patch };   /* 仅内存；磁盘真相由相邻的 git remote add|remove / clone 落盘 */
  return config;
}
let config = { remote: readOriginFromGitConfig() };
/* 遗留清理（单一事实源改造遗留，若干版本后可移除）：旧版把远端地址存 config.json、日志名叫 log，均已废弃 */
for (const legacy of [path.join(HOME_DIR, 'config.json'), path.join(HOME_DIR, 'log')]) {
  try { fs.rmSync(legacy, { force: true }); } catch (_) {}
}
/* 分支定死 main（2026-10-27）：本地 main ↔ 远端 origin/main，无切换、无改名；远端无 main 时推送自动建立 */
const MAIN_BRANCH = 'main';
function isSshRemote(u) { return /^[\w.-]+@[\w.-]+:/.test(u || '') || /^ssh:\/\//.test(u || ''); }

/* ================= git 基础设施 ================= */

function sshCommand() {
  const key = KEY_FILE.replace(/\\/g, '/');
  const kh = KNOWN_HOSTS.replace(/\\/g, '/');
  return `ssh -i "${key}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${kh}"`;
}

function git(args, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 60000;
  const cwd = opts.cwd || REPO_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_SSH_COMMAND: sshCommand(), GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} 超时（${timeout / 1000}s）`));
    }, timeout);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('无法启动 git，请确认已安装并加入 PATH：' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function gitOk(args, opts) {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} 失败：${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  return r;
}

function checkGitAvailable() {
  return new Promise((resolve) => {
    const child = spawn('git', ['--version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && /git version/.test(out)));
  });
}

/* ================= 状态机：fresh → local →（绑定）→ ready ================= */

function hasRepo() { return fs.existsSync(path.join(REPO_DIR, '.git')); }

function stage() {
  if (cloneState.active) return 'cloning';
  if (!hasRepo()) return 'fresh';
  if (!config.remote) return 'local';
  return 'ready';
}

const cloneState = { active: false, phase: '', progress: 0, error: '' };
const syncState = { busy: false, phase: '', lastError: '', conflict: null, lastAt: null, ahead: 0, behind: 0 };

function conflictError(files) {
  const e = new Error('存在无法自动合并的冲突：' + files.join('、'));
  e.status = 409;
  e.conflict = files;
  return e;
}

/* 同步策略：优先 rebase，其次 merge；仍冲突则进入「冲突待处理」 */
async function integrateRemote() {
  let r = await git(['rebase', 'origin/' + MAIN_BRANCH]);
  if (r.code === 0) return;
  await git(['rebase', '--abort']);
  // 绑定/同步语义允许叠加无关历史（git 默认拒绝，需显式放行）；放行后仍冲突才走冲突路径
  r = await git(['merge', '--allow-unrelated-histories', 'origin/' + MAIN_BRANCH]);
  if (r.code === 0) return;
  // 用 ls-files -u 取冲突清单（--diff-filter=U 只认 modify/modify 的 UU，认不出 add/add 的 AA）
  const conf = await git(['ls-files', '-u']);
  const files = [...new Set(conf.stdout.split(/\r?\n/).map((l) => {
    const i = l.indexOf('\t');
    return i > -1 ? l.slice(i + 1).trim() : '';
  }).filter(Boolean))];
  await git(['merge', '--abort']);
  syncState.conflict = files;
  throw conflictError(files);
}

async function pushWithRetry() {
  for (let i = 0; i < 3; i++) {
    const p = await git(['push', 'origin', MAIN_BRANCH], { timeout: 300000 });
    if (p.code === 0) { syncState.ahead = 0; syncState.conflict = null; return; }
    await gitOk(['fetch', 'origin'], { timeout: 300000 });
    syncState.phase = '整合远端重试 ' + (i + 1);
    await integrateRemote();
  }
  throw new Error('推送失败：远端持续有新提交，请稍后手动同步重试。');
}

async function doSync() {
  if (!config.remote) return { local: true, ahead: 0, behind: 0 };
  syncState.busy = true;
  syncState.lastError = '';
  try {
    syncState.phase = '获取远端';
    await gitOk(['fetch', 'origin'], { timeout: 300000 });
    const br = MAIN_BRANCH;
    // 本地分支必须是 main（应用创建的仓库恒为 main，若不是说明仓库被外部改动过），不自动改名
    const cur = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (cur !== br) throw httpError(409, '本地分支不是 ' + br + '（应用创建的仓库不应出现此情况），请检查本地仓库');
    // 远端没有 main：不管远端其他分支，直接把本地 main 推上去新建，完成
    const hasRemoteRef = (await git(['rev-parse', '--verify', '--quiet', 'origin/' + br])).code === 0;
    if (!hasRemoteRef) {
      syncState.phase = '新建远端 ' + br + ' 分支';
      await gitOk(['push', '-u', 'origin', br], { timeout: 300000 });
      syncState.ahead = 0; syncState.behind = 0; syncState.conflict = null;
      syncState.lastAt = new Date().toISOString();
      return { ahead: 0, behind: 0, created: br };
    }
    const cnt = await gitOk(['rev-list', '--left-right', '--count', `${br}...origin/${br}`]);
    const [ahead, behind] = cnt.stdout.trim().split(/\s+/).map(Number);
    syncState.ahead = ahead; syncState.behind = behind;
    const localCount = parseInt((await git(['rev-list', '--count', 'HEAD'])).stdout.trim() || '0', 10);
    if (localCount === 0) {
      // 本地还没有提交：直接采用远端内容（补上本地缺的）
      await gitOk(['reset', '--hard', 'origin/' + br]);
      syncState.ahead = 0; syncState.behind = 0;
      syncState.lastAt = new Date().toISOString();
      return { ahead: 0, behind: 0, fastForward: true };
    }
    if (behind > 0) {
      syncState.phase = `整合远端（落后 ${behind} 个提交）`;
      await integrateRemote();
      syncState.behind = 0;
    }
    if (syncState.ahead > 0) {
      syncState.phase = `推送（领先 ${syncState.ahead} 个提交）`;
      await pushWithRetry();
    }
    syncState.lastAt = new Date().toISOString();
    return { ahead: syncState.ahead, behind: 0 };
  } catch (e) {
    syncState.lastError = e.conflict ? '存在冲突，等待处理' : String(e.message || e);
    throw e;
  } finally {
    syncState.busy = false;
    syncState.phase = '';
    clearPyCache();   /* 同步后远端内容可能已并入，拼音索引失效 */
  }
}

let writeQueue = Promise.resolve();
let writeBusy = false;
function enqueueWrite(fn) {
  writeBusy = true;
  const p = writeQueue.then(fn);
  writeQueue = p.catch(() => {});          /* 队列链吞掉拒绝，避免未处理拒绝 */
  p.catch(() => {}).finally(() => { writeBusy = false; clearPyCache(); });   /* 写后拼音索引失效 */
  return p;
}

/* ================= 首次配置：仅本机 init / 克隆远端 ================= */

async function setupLocal() {
  if (hasRepo()) return { ready: true };
  fs.mkdirSync(REPO_DIR, { recursive: true });
  await gitOk(['init', '-b', 'main'], { cwd: REPO_DIR });
  await ensureAuthor();
  fs.mkdirSync(path.join(REPO_DIR, 'settings'), { recursive: true });
  writeMainRaw(defaultMain());
  await gitOk(['add', '--', MAIN_JSON]);
  await gitOk(['commit', '-m', 'settings: init']);
  saveConfig({ remote: '' });
  return { ready: true };
}

async function ensureKey() {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE) && fs.existsSync(PUB_FILE)) return fs.readFileSync(PUB_FILE, 'utf8').trim();
  const comment = 'git-notes-' + os.hostname() + '-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = await new Promise((resolve) => {
    const child = spawn('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', KEY_FILE, '-q'], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', () => resolve('无法启动 ssh-keygen，请确认已安装 Git/OpenSSH 并加入 PATH'));
    child.on('close', (code) => resolve(code === 0 ? '' : (err.trim() || 'ssh-keygen 退出码 ' + code)));
  });
  if (r) throw httpError(500, r);
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) {}
  return fs.readFileSync(PUB_FILE, 'utf8').trim();
}

/* 密钥泄漏时的用户自救：删除旧密钥对并重新生成（旧公钥在 git 服务器上立即失效） */
async function rotateKey() {
  if (syncState.busy || writeBusy) throw httpError(409, '同步或写入进行中');
  try { fs.unlinkSync(KEY_FILE); } catch (_) {}
  try { fs.unlinkSync(PUB_FILE); } catch (_) {}
  const pubKey = await ensureKey();
  return { pubKey, rotated: true };
}

/* 导入用户已有私钥（OpenSSH 格式、无口令；任意算法类型）：派生公钥校验通过后才落地覆盖 */
async function importKey(privateKey) {
  if (syncState.busy || writeBusy) throw httpError(409, '同步或写入进行中');
  const raw = String(privateKey || '').replace(/\r\n/g, '\n').trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----$/.test(raw.split('\n')[0] || '')) {
    throw httpError(400, '不是 OpenSSH 私钥：内容需以 -----BEGIN … PRIVATE KEY----- 开头');
  }
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const tmp = KEY_FILE + '.import-tmp';
  fs.writeFileSync(tmp, raw + '\n');
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  // ssh-keygen -y 派生公钥：失败（格式错/带口令）即拒绝；立即关 stdin + 超时兜底防带口令私钥挂起
  const pub = await new Promise((resolve) => {
    const child = spawn('ssh-keygen', ['-y', '-f', tmp], { windowsHide: true });
    let out = '';
    let timer = setTimeout(() => { child.kill(); resolve(''); }, 5000);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim() : ''); });
    child.stdin.end();
  });
  if (!pub || !/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+)\s+[A-Za-z0-9+/=]+/.test(pub)) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw httpError(400, '私钥无效或带口令：仅支持无口令的 OpenSSH 格式私钥');
  }
  fs.renameSync(tmp, KEY_FILE);
  fs.writeFileSync(PUB_FILE, pub + '\n');
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) {}
  return { pubKey: pub, imported: true };
}

function readPrivateKey() {
  if (!fs.existsSync(KEY_FILE)) throw httpError(404, '本机尚无 SSH 私钥');
  return { privateKey: fs.readFileSync(KEY_FILE, 'utf8') };
}

/* 打开本地仓库文件夹（仅桌面端有意义；路径固定，不接受客户端传参） */
function openRepo() {
  if (!hasRepo()) throw httpError(409, '本地仓库尚未初始化');
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [REPO_DIR], { detached: true, stdio: 'ignore' });
    child.once('error', (e) => reject(httpError(500, '无法打开文件夹：' + e.message)));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, path: REPO_DIR }); });
  });
}

async function startClone(remote) {
  if (cloneState.active) throw httpError(409, '克隆正在进行中');
  if (hasRepo()) throw httpError(409, '本地已存在仓库（如需重新克隆请先删除 ' + REPO_DIR + '）');
  if (!remote) throw httpError(400, '缺少远端地址');
  if (isSshRemote(remote)) await ensureKey();
  fs.mkdirSync(HOME_DIR, { recursive: true });
  cloneState.active = true; cloneState.phase = '连接远端'; cloneState.progress = 0; cloneState.error = '';
  const child = spawn('git', ['clone', '--progress', remote, REPO_DIR], {
    cwd: HOME_DIR,
    env: { ...process.env, GIT_SSH_COMMAND: sshCommand(), GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
  });
  let errBuf = '';
  const timer = setTimeout(() => {
    child.kill();
    cloneState.active = false;
    cloneState.error = '克隆超时（15 分钟），请检查网络后重试';
  }, 15 * 60 * 1000);
  child.stderr.on('data', (c) => {
    errBuf += c;
    const m = /(Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/.exec(errBuf.slice(-400));
    if (m) { cloneState.phase = m[1]; cloneState.progress = Number(m[2]); }
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    cloneState.active = false;
    cloneState.error = '无法启动 git：' + e.message;
  });
  child.on('close', async (code) => {
    clearTimeout(timer);
    cloneState.active = false;
    if (code === 0) {
      cloneState.phase = '完成'; cloneState.progress = 100;
      /* 空仓库克隆（新用户新建空仓直连的主场景）rev-parse HEAD 会报错——绑定落库必须先行，改名/作者初始化失败单独吞掉 */
      saveConfig({ remote });
      try {
        /* 分支定死 main：不管远端 HEAD 指向什么（空仓/master/其他），本地一律立到 main——
           main 不存在则 symbolic-ref 直接把未出生 HEAD 指向 main，首个提交即诞生于 main；
           main 已存在则是空操作。symbolic-ref 对空仓克隆（无任何提交）同样有效，rev-parse HEAD 则会报错 */
        await gitOk(['symbolic-ref', 'HEAD', 'refs/heads/' + MAIN_BRANCH]);
      } catch (_) {}
      try { await ensureAuthor(); } catch (_) {}
    } else {
      const tail = errBuf.trim().split(/\r?\n/).filter(Boolean).pop() || ('退出码 ' + code);
      cloneState.error = tail;
      fs.rmSync(REPO_DIR, { recursive: true, force: true });
    }
  });
  return { started: true };
}

/* ================= 连接远端（local → ready）：只登记远端地址，不做任何 git 网络操作 =================
   fetch/分支校验/合并/推送全部延迟到「立即同步」（doSync）时才发生 */

async function bindConnect(remote) {
  if (stage() !== 'local') throw httpError(409, '仅「仅本机使用」模式可连接远端');
  if (!remote || /\s/.test(remote)) throw httpError(400, '远端地址不能为空且不能含空格');
  const hasOrigin = (await git(['remote'])).stdout.split(/\r?\n/).includes('origin');
  if (hasOrigin) await gitOk(['remote', 'remove', 'origin']);
  await gitOk(['remote', 'add', 'origin', remote]);
  saveConfig({ remote });
  return { connected: true };
}

async function unbind() {
  if (stage() !== 'ready') throw httpError(409, '当前未连接远端');
  const hasOrigin = (await git(['remote'])).stdout.split(/\r?\n/).includes('origin');
  if (hasOrigin) await gitOk(['remote', 'remove', 'origin']);
  syncState.conflict = null;
  saveConfig({ remote: '' });
}

async function forcePush() {
  if (stage() !== 'ready') throw httpError(409, '当前未连接远端');
  const p = await git(['push', '--force', 'origin', MAIN_BRANCH], { timeout: 300000 });
  if (p.code !== 0) throw new Error('强制推送失败：' + (p.stderr || p.stdout).trim().split('\n')[0]);
  syncState.ahead = 0;
  syncState.conflict = null;
  syncState.lastError = '';
  syncState.lastAt = new Date().toISOString();
}

/* 同步冲突二选一之一：远端覆盖本地（reset --hard 到 origin/main），本地未推送的提交将丢失 */
async function remoteOverwrite() {
  if (stage() !== 'ready') throw httpError(409, '当前未连接远端');
  const r = await git(['reset', '--hard', 'origin/' + MAIN_BRANCH]);
  if (r.code !== 0) throw new Error('远端覆盖失败：' + (r.stderr || r.stdout).trim().split('\n')[0]);
  syncState.ahead = 0;
  syncState.behind = 0;
  syncState.conflict = null;
  syncState.lastError = '';
  syncState.lastAt = new Date().toISOString();
  clearPyCache();
  return { overwritten: true };
}

function ensureReady() {
  if (stage() !== 'ready' && stage() !== 'local') throw httpError(409, '尚未完成首次配置');
}

/* ================= 数据格式（沿用 micro/ 规范） ================= */

function pad2(n) { return String(n).padStart(2, '0'); }
function tsOf(d) {
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function createdStr(d) {
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function summarize(text, imgCount) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 12);
  return imgCount ? ('图' + imgCount + '张') : '微笔记';
}
function buildMicroMd(tags, created, images, text, files) {
  const L = ['---', 'type: micro'];
  if (tags.length) L.push('tags: ' + JSON.stringify(tags));
  L.push('created: "' + created + '"');
  if (images.length) {
    L.push('images:');
    for (let i = 0; i < images.length; i++) L.push('  - ' + images[i]);
  }
  if (files && files.length) {
    L.push('files:');
    for (let i = 0; i < files.length; i++) L.push('  - ' + files[i]);
  }
  L.push('---', '', text.trim());
  return L.join('\n') + '\n';
}
function parsePost(raw, relPath) {
  const name = relPath.split('/').pop();
  const stem = name.replace(/\.md$/, '');
  const fm = {}; let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = raw.slice(m[0].length);
    let lastKey = null;
    m[1].split(/\r?\n/).forEach((line) => {
      const item = line.match(/^\s+-\s*(.*)$/);
      if (item && lastKey && (fm[lastKey] === '' || Array.isArray(fm[lastKey]))) {
        if (!Array.isArray(fm[lastKey])) fm[lastKey] = [];
        fm[lastKey].push(item[1].trim().replace(/^["']|["']$/g, ''));
        return;
      }
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) return;
      let v = kv[2].trim();
      lastKey = kv[1];
      if (v === '') { fm[kv[1]] = ''; return; }
      if (v.charAt(0) === '[' && v.charAt(v.length - 1) === ']') {
        v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else {
        v = v.replace(/^["']|["']$/g, '');
      }
      fm[kv[1]] = v;
    });
  }
  return {
    path: relPath, name, stem,
    dir: relPath.split('/').slice(0, -1).join('/'),
    created: typeof fm.created === 'string' ? fm.created : '',
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    images: Array.isArray(fm.images) ? fm.images : [],
    files: Array.isArray(fm.files) ? fm.files.map((s) => {
      const i = s.indexOf('|');
      return i === -1 ? { name: s, path: s } : { name: s.slice(0, i) || s.slice(i + 1), path: s.slice(i + 1) };
    }) : [],
    text: body.trim(),
  };
}
function readPost(relPath) {
  return parsePost(fs.readFileSync(path.join(REPO_DIR, relPath), 'utf8'), relPath);
}

async function ensureAuthor() {
  const repoName = (await git(['config', 'user.name'])).stdout.trim();
  if (repoName) return;
  const globName = (await git(['config', '--global', 'user.name'])).stdout.trim();
  const globMail = (await git(['config', '--global', 'user.email'])).stdout.trim();
  if (globName && globMail) return;
  await gitOk(['config', 'user.name', globName || 'git-notes']);
  await gitOk(['config', 'user.email', globMail || 'git-notes@local']);
}

/* ================= 写操作（路径白名单：micro/ 与 settings/main.json） ================= */

function assertPostPath(p) {
  if (typeof p !== 'string' || !/^micro\/\d{4}\/\d{2}\/[A-Za-z0-9._-]+\.md$/.test(p)) {
    throw httpError(400, '非法的笔记路径');
  }
  const abs = path.join(REPO_DIR, p);
  if (!abs.startsWith(path.join(REPO_DIR, 'micro') + path.sep)) throw httpError(400, '非法的笔记路径');
  return abs;
}
function validTags(tags) {
  if (!Array.isArray(tags) || tags.length > 20) throw httpError(400, '标签数量超限');
  return tags.map((t) => String(t).trim().replace(/[\[\]",{}]/g, '').replace(/\s+/g, ' ').slice(0, 16)).filter(Boolean);
}
function validImages(imgs) {
  if (imgs === undefined || imgs === null) return [];
  if (!Array.isArray(imgs) || imgs.length > MAX_IMAGES) throw httpError(400, '最多 ' + MAX_IMAGES + ' 张图');
  return imgs.map((im) => {
    const ext = String(im.ext || '').toLowerCase();
    const b64 = String(im.base64 || '');
    if (!IMG_MIME[ext]) throw httpError(400, '仅支持图片（png/jpg/webp/gif/bmp/avif）');
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64) || b64.length > 14 * 1024 * 1024) throw httpError(400, '图片数据非法或超过 10MB');
    return { ext, buf: Buffer.from(b64.replace(/\s+/g, ''), 'base64') };
  });
}
/* 附件原始文件名消毒：剥离 |、控制字符与换行（md 条目用 | 分隔 原名|磁盘名），截断 120 字符 */
function sanitizeFileName(name) {
  let s = String(name || '').replace(/[|\r\n\t\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return s || 'file';
}
function validFiles(files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.length > MAX_FILES) throw httpError(400, '最多 ' + MAX_FILES + ' 个附件');
  return files.map((f) => {
    const name = sanitizeFileName(f && f.name);
    const ext = String((f && f.ext) || '').toLowerCase();
    if (!/^[a-z0-9]{1,12}$/.test(ext)) throw httpError(400, '附件扩展名非法');
    const b64 = String((f && f.base64) || '');
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64) || b64.length > 14 * 1024 * 1024) throw httpError(400, '附件数据非法或超过 10MB');
    return { name, ext, buf: Buffer.from(b64.replace(/\s+/g, ''), 'base64') };
  });
}
function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/* 提交并按需推送：仅本机模式只 commit，绑定远端后 commit + push */
async function commitAndPush(paths, msg) {
  await gitOk(['add'].concat(['--'], paths));
  const st = await git(['commit', '-m', msg]);
  if (st.code !== 0) return; // 无实际变化
  if (config.remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
}

async function writePreSync() {
  if (config.remote) await doSync();
}

async function writePost({ text, tags, images, files, ai }) {
  ensureReady();
  await writePreSync();
  await ensureAuthor();
  const cleanTags = validTags(tags);
  const imgs = validImages(images);
  const fls = validFiles(files);
  const now = new Date();
  const dir = 'micro/' + now.getFullYear() + '/' + pad2(now.getMonth() + 1);
  fs.mkdirSync(path.join(REPO_DIR, dir), { recursive: true });
  const stem = tsOf(now);
  /* 附件磁盘名用 -fN 命名空间，与图片 -N 互不干扰（updatePost 的图片序号正则 -(d+). 不会误吞 -fN） */
  const names = imgs.map((im, i) => stem + '-' + (i + 1) + '.' + im.ext);
  const fileNames = fls.map((f, i) => stem + '-f' + (i + 1) + '.' + f.ext);
  const rel = dir + '/' + stem + '.md';
  const summary = summarize(text, imgs.length);
  if (fs.existsSync(path.join(REPO_DIR, rel))) throw httpError(409, '同一秒内已有发布，请稍候 1 秒重试');
  fs.writeFileSync(path.join(REPO_DIR, rel), buildMicroMd(cleanTags, createdStr(now), names, String(text || ''), fls.map((f, i) => f.name + '|' + fileNames[i])));
  imgs.forEach((im, i) => fs.writeFileSync(path.join(REPO_DIR, dir, names[i]), im.buf));
  fls.forEach((f, i) => fs.writeFileSync(path.join(REPO_DIR, dir, fileNames[i]), f.buf));
  await commitAndPush([rel].concat(names.map((n) => dir + '/' + n), fileNames.map((n) => dir + '/' + n)), 'micro: add ' + summary + (ai ? ' [ai]' : ''));
  return { path: rel, name: stem + '.md', stem, dir, created: createdStr(now), tags: cleanTags, images: names, files: fls.map((f, i) => ({ name: f.name, path: fileNames[i] })), text: String(text || '').trim() };
}

async function updatePost({ path: rel, text, tags, keepNames, newImages, keepFileNames, newFiles, ai }) {
  ensureReady();
  await writePreSync();
  await ensureAuthor();
  assertPostPath(rel);
  if (!fs.existsSync(path.join(REPO_DIR, rel))) throw httpError(404, '笔记不存在（可能已在其他设备删除）');
  const cur = readPost(rel);
  const cleanTags = validTags(tags);
  const keep = Array.isArray(keepNames) ? keepNames.filter((n) => typeof n === 'string' && cur.images.indexOf(n) > -1) : cur.images;
  const newImgs = validImages(newImages);
  if (keep.length + newImgs.length > MAX_IMAGES) throw httpError(400, '最多 ' + MAX_IMAGES + ' 张图');
  const keepF = Array.isArray(keepFileNames)
    ? cur.files.filter((f) => keepFileNames.indexOf(f.path) > -1)
    : cur.files;
  const newFls = validFiles(newFiles);
  if (keepF.length + newFls.length > MAX_FILES) throw httpError(400, '最多 ' + MAX_FILES + ' 个附件');
  const removed = cur.images.filter((n) => keep.indexOf(n) === -1);
  const removedF = cur.files.filter((f) => keepF.indexOf(f) === -1).map((f) => f.path);
  let seq = 0;
  keep.concat(removed).forEach((nm) => {
    const mm = /-(\d+)\.[A-Za-z0-9]+$/.exec(nm);
    if (mm) seq = Math.max(seq, parseInt(mm[1], 10));
  });
  let fseq = 0;
  keepF.map((f) => f.path).concat(removedF).forEach((p) => {
    const mm = /-f(\d+)\.[A-Za-z0-9]+$/.exec(p);
    if (mm) fseq = Math.max(fseq, parseInt(mm[1], 10));
  });
  const names = newImgs.map((im) => cur.stem + '-' + (++seq) + '.' + im.ext);
  const fileNames = newFls.map((f) => cur.stem + '-f' + (++fseq) + '.' + f.ext);
  const summary = summarize(text, keep.length + newImgs.length);
  fs.writeFileSync(path.join(REPO_DIR, rel), buildMicroMd(cleanTags, cur.created, keep.concat(names), String(text || ''), keepF.map((f) => f.name + '|' + f.path).concat(newFls.map((f, i) => f.name + '|' + fileNames[i]))));
  newImgs.forEach((im, i) => fs.writeFileSync(path.join(REPO_DIR, cur.dir, names[i]), im.buf));
  newFls.forEach((f, i) => fs.writeFileSync(path.join(REPO_DIR, cur.dir, fileNames[i]), f.buf));
  removed.concat(removedF).forEach((nm) => {
    const f = path.join(REPO_DIR, cur.dir, nm);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
  await gitOk(['add', '-A', '--', cur.dir]);
  const st = await git(['commit', '-m', 'micro: update ' + summary + (ai ? ' [ai]' : '')]);
  if (st.code === 0 && config.remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
  return { path: rel, name: cur.name, stem: cur.stem, dir: cur.dir, created: cur.created, tags: cleanTags, images: keep.concat(names), files: keepF.map((f) => ({ name: f.name, path: f.path })).concat(newFls.map((f, i) => ({ name: f.name, path: fileNames[i] }))), text: String(text || '').trim() };
}

async function deletePost({ path: rel, ai }) {
  ensureReady();
  await writePreSync();
  assertPostPath(rel);
  if (!fs.existsSync(path.join(REPO_DIR, rel))) throw httpError(404, '笔记不存在');
  const cur = readPost(rel);
  const summary = summarize(cur.text, cur.images.length);
  const files = [rel].concat(cur.images.map((nm) => cur.dir + '/' + nm), cur.files.map((f) => cur.dir + '/' + f.path));
  const r = await git(['rm', '-q', '--'].concat(files));
  if (r.code !== 0) {
    files.forEach((f) => { try { fs.unlinkSync(path.join(REPO_DIR, f)); } catch (_) {} });
    await gitOk(['add', '-A', '--', cur.dir]);
  }
  /* 钉住清单里的残留顺手清掉，与删除同一提交落地 */
  if (readMain().pins.indexOf(rel) > -1) {
    const m = readMain();
    m.pins = m.pins.filter((p) => p !== rel);
    writeMainRaw(m);
    await gitOk(['add', '--', MAIN_JSON]);
  }
  await gitOk(['commit', '-m', 'micro: delete ' + summary + (ai ? ' [ai]' : '')]);
  if (config.remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
}

/* ================= git 历史（AI 工具用）：只读查阅 / 时点读取 / 恢复=新提交，绝不重写历史 ================= */
async function gitLog({ limit, path: rel }) {
  ensureReady();
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const args = ['log', '--max-count=' + n, '--date=iso-strict', '--format=%H%x09%ad%x09%s'];
  if (rel) { assertPostPath(rel); args.push('--', rel); }
  const r = await git(args);
  const commits = r.stdout.split('\n').filter(Boolean).map((line) => {
    const p = line.split('\t');
    return { hash: p[0] || '', date: p[1] || '', subject: p[2] || '' };
  }).filter((c) => c.hash);
  return { commits };
}
async function gitShow({ path: rel, commit }) {
  ensureReady();
  assertPostPath(rel);
  if (!/^[0-9a-fA-F]{7,40}$/.test(String(commit || ''))) throw httpError(400, 'commit 无效');
  const r = await git(['show', commit + ':' + rel]);
  if (r.code !== 0) throw httpError(404, '该提交中不存在此文件');
  return { text: r.stdout };
}
async function gitRestore({ path: rel, commit, ai }) {
  ensureReady();
  await writePreSync();
  await ensureAuthor();
  assertPostPath(rel);
  if (!/^[0-9a-fA-F]{7,40}$/.test(String(commit || ''))) throw httpError(400, 'commit 无效');
  const r = await git(['show', commit + ':' + rel]);
  if (r.code !== 0) throw httpError(404, '该提交中不存在此文件');
  /* 只恢复 md 本体；md 里引用的图片若已随删除提交移除，前端按 img-miss 展示 */
  fs.writeFileSync(path.join(REPO_DIR, rel), r.stdout);
  const cur = readPost(rel);
  await gitOk(['add', '--', rel]);
  const st = await git(['commit', '-m', 'micro: update ' + summarize(cur.text, cur.images.length) + (ai ? ' [ai]' : ' [restore]')]);
  if (st.code === 0 && config.remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
  return { path: rel, restored: true };
}

/* ================= AI 文件操作与全量 git（AI 工具用） =================
   作用域红线：所有路径规范化后必须落在 REPO_DIR 内；.git 段与 .. 一律拒绝。
   fs_* 只落盘不提交（统一走 git_* 工具提交，历史可审计）；覆盖前副本存 HOME_DIR/.fs-backup/（仓外，防污染仓库）。 */
function assertRepoPath(p, opts) {
  opts = opts || {};
  if (typeof p !== 'string') throw httpError(400, '路径不能为空');
  const segs = p.replace(/\\/g, '/').trim().split('/').filter((s) => s !== '' && s !== '.');
  if (p.replace(/\\/g, '/').trim().startsWith('/')) throw httpError(400, '路径须为仓库相对路径');
  if (segs.some((s) => s === '..' || s.toLowerCase() === '.git' || /^[A-Za-z]:$/.test(s))) throw httpError(400, '路径非法（禁止 ..、.git 与盘符）');
  if (!segs.length && !opts.allowRoot) throw httpError(400, '路径不能为仓库根目录');
  const abs = path.join(REPO_DIR, ...segs);
  if (abs !== REPO_DIR && !abs.startsWith(REPO_DIR + path.sep)) throw httpError(400, '路径越界');
  return { rel: segs.join('/'), abs };
}
function fsStatSafe(abs) {
  try { return fs.statSync(abs); } catch (_) { return null; }
}
function fsList(q) {
  ensureReady();
  const { rel, abs } = assertRepoPath(q || '', { allowRoot: true });
  const st = fsStatSafe(abs);
  if (rel && !st) throw httpError(404, '路径不存在：' + rel);
  if (st && !st.isDirectory()) throw httpError(400, '不是目录：' + rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.name !== '.git')
    .map((e) => {
      const s = fsStatSafe(path.join(abs, e.name));
      return {
        name: e.name,
        type: e.isDirectory() ? 'dir' : (e.isFile() ? 'file' : 'other'),
        size: s ? s.size : 0,
        mtime: s ? s.mtime.toISOString() : '',
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
  return { path: rel, entries, count: entries.length };
}
function fsRead(q) {
  ensureReady();
  const { rel, abs } = assertRepoPath(q);
  const st = fsStatSafe(abs);
  if (!st || !st.isFile()) throw httpError(404, '文件不存在：' + rel);
  const MAX = 10 * 1024 * 1024;
  if (st.size > MAX) throw httpError(400, '文件超过 10MB，AI 无法读取：' + rel);
  const buf = fs.readFileSync(abs);
  const head = buf.subarray(0, 8192);
  const binary = head.includes(0);
  if (binary) return { path: rel, encoding: 'base64', size: st.size, truncated: false, content: buf.toString('base64') };
  return { path: rel, encoding: 'text', size: st.size, truncated: false, content: buf.toString('utf8') };
}
function backupIfExists(abs, name) {
  const st = fsStatSafe(abs);
  if (!st) return false;
  const bdir = path.join(HOME_DIR, '.fs-backup');
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(abs, path.join(bdir, stamp + '-' + name));
  return true;
}
async function fsWrite(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
  return enqueueWrite(() => {
    const { rel, abs } = assertRepoPath(body && body.path);
    const isB64 = body && body.encoding === 'base64';
    const raw = String((body && body.content) || '');
    if (isB64 && !/^[A-Za-z0-9+/=\r\n]*$/.test(raw)) throw httpError(400, 'base64 数据非法');
    const buf = isB64 ? Buffer.from(raw.replace(/\s+/g, ''), 'base64') : Buffer.from(raw, 'utf8');
    if (buf.length > 20 * 1024 * 1024) throw httpError(413, '内容超过 20MB 上限');
    const st = fsStatSafe(abs);
    if (st && st.isDirectory()) throw httpError(400, '同名目录已存在：' + rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const backed = backupIfExists(abs, rel.split('/').pop());
    fs.writeFileSync(abs, buf);
    return { path: rel, size: buf.length, overwrote: !!st, backup: backed };
  });
}
async function fsDelete(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
  const paths = Array.isArray(body && body.paths) ? body.paths : (body && body.path ? [body.path] : []);
  if (!paths.length || paths.length > 50) throw httpError(400, 'paths 须为 1~50 个路径');
  return enqueueWrite(() => {
    const out = paths.map((p) => {
      const { rel, abs } = assertRepoPath(p);
      const st = fsStatSafe(abs);
      if (!st) return { path: rel, error: '不存在' };
      if (st.isDirectory()) {
        if (fs.readdirSync(abs).length) return { path: rel, error: '目录非空，先删空其中文件' };
        fs.rmdirSync(abs);
      } else {
        backupIfExists(abs, rel.split('/').pop());
        fs.unlinkSync(abs);
      }
      return { path: rel, deleted: true };
    });
    clearPyCache();
    return { results: out };
  });
}
async function fsMove(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
  return enqueueWrite(() => {
    const { rel: from, abs: fromAbs } = assertRepoPath(body && body.from);
    const { rel: to, abs: toAbs } = assertRepoPath(body && body.to);
    const st = fsStatSafe(fromAbs);
    if (!st) throw httpError(404, '源不存在：' + from);
    if (fsStatSafe(toAbs)) throw httpError(409, '目标已存在：' + to);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    clearPyCache();
    return { from, to };
  });
}
async function fsMkdir(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
  return enqueueWrite(() => {
    const { rel, abs } = assertRepoPath(body && body.path);
    if (fsStatSafe(abs)) throw httpError(409, '已存在：' + rel);
    fs.mkdirSync(abs, { recursive: true });
    return { path: rel };
  });
}

/* ---- 全量 git（面向 AI）：add 只收显式路径清单（不做 add -A / add .），提交/推拉/差异/分支/文件级恢复 ---- */
async function gitStatus() {
  ensureReady();
  const r = await git(['status', '--porcelain=v1', '-b']);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  let branch = '', upstream = '', ahead = 0, behind = 0;
  const entries = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const m = /^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.*)\])?$/.exec(line.slice(3).trim());
      if (m) {
        branch = m[1];
        upstream = m[2] || '';
        const ab = /ahead (\d+)/.exec(m[3] || ''), bd = /behind (\d+)/.exec(m[3] || '');
        ahead = ab ? parseInt(ab[1], 10) : 0;
        behind = bd ? parseInt(bd[1], 10) : 0;
      }
      continue;
    }
    entries.push({ x: line.slice(0, 1), y: line.slice(1, 2), path: line.slice(3) });
  }
  return { branch, upstream, ahead, behind, entries, count: entries.length, clean: !entries.length };
}
async function gitAdd(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
  const paths = Array.isArray(body && body.paths) ? body.paths.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (!paths.length || paths.length > 200) throw httpError(400, 'paths 须为 1~200 个路径（显式清单，不做全仓 add）');
  const rels = paths.map((p) => assertRepoPath(p).rel);
  return enqueueWrite(async () => {
    await gitOk(['add', '--'].concat(rels));
    const st = await gitStatus();
    return { added: rels, stagedCount: st.entries.filter((e) => e.x !== ' ' && e.x !== '?').length };
  });
}
async function gitCommit(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
  const msg = String((body && body.message) || '').trim();
  if (!msg || msg.length > 500) throw httpError(400, '提交消息不能为空且不超过 500 字符');
  return enqueueWrite(async () => {
    await ensureAuthor();
    const staged = await git(['diff', '--cached', '--name-only']);
    if (!staged.stdout.trim()) throw httpError(400, '暂存区为空：先用 git_add 暂存要提交的文件');
    await gitOk(['commit', '-m', msg]);
    const hash = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
    if (config.remote) {
      const cnt = await gitOk(['rev-list', '--count', 'origin/' + MAIN_BRANCH + '..HEAD']);
      return { committed: true, hash, message: msg, unpushed: parseInt(cnt.stdout.trim() || '0', 10) };
    }
    return { committed: true, hash, message: msg, unpushed: 0 };
  });
}
async function gitPush() {
  ensureReady();
  if (!config.remote) throw httpError(409, '仅本机模式无远端可推送');
  if (syncState.busy || writeBusy) throw httpError(409, '同步或写入进行中');
  return enqueueWrite(async () => {
    const r = await git(['push', 'origin', MAIN_BRANCH], { timeout: 300000 });
    if (r.code !== 0) throw new Error('推送失败：' + (r.stderr || r.stdout).trim().split('\n')[0]);
    syncState.ahead = 0;
    syncState.lastAt = new Date().toISOString();
    return { pushed: true };
  });
}
async function gitPull() {
  ensureReady();
  if (!config.remote) throw httpError(409, '仅本机模式无远端可拉取');
  if (syncState.busy || writeBusy) throw httpError(409, '同步或写入进行中');
  return enqueueWrite(async () => {
    syncState.busy = true;
    syncState.lastError = '';
    try {
      syncState.phase = '获取远端';
      await gitOk(['fetch', 'origin'], { timeout: 300000 });
      const br = MAIN_BRANCH;
      const hasRemoteRef = (await git(['rev-parse', '--verify', '--quiet', 'origin/' + br])).code === 0;
      if (!hasRemoteRef) return { pulled: false, note: '远端尚无分支 ' + br + '，无可整合内容' };
      const cnt = await gitOk(['rev-list', '--left-right', '--count', br + '...origin/' + br]);
      const [ahead, behind] = cnt.stdout.trim().split(/\s+/).map(Number);
      if (!behind) return { pulled: false, note: '已是最新（远端无新提交）', ahead };
      syncState.phase = '整合远端（落后 ' + behind + ' 个提交）';
      await integrateRemote();
      syncState.behind = 0;
      syncState.lastAt = new Date().toISOString();
      return { pulled: true, integrated: behind, ahead };
    } catch (e) {
      syncState.lastError = e.conflict ? '存在冲突，等待处理' : String(e.message || e);
      throw e;
    } finally {
      syncState.busy = false;
      syncState.phase = '';
      clearPyCache();
    }
  });
}
async function gitDiff(q) {
  ensureReady();
  const from = String((q && q.from) || ''), to = String((q && q.to) || '');
  const hex = (s, label) => {
    if (s && !/^[0-9a-fA-F]{7,40}$/.test(s) && !/^HEAD(~\d+)?$/.test(s) && s !== 'STAGED') throw httpError(400, label + ' 无效');
    return s;
  };
  hex(from, 'from'); hex(to, 'to');
  const args = ['diff', '--no-color'];
  if ((q && q.mode) === 'stat') args.push('--stat');
  if (from === 'STAGED' || (!from && !to && (q && q.mode) === 'staged')) args.push('--cached');
  else if (from && to) args.push(from, to);
  else if (from) args.push(from);
  else args.push('HEAD');
  let rel = '';
  if (q && q.path) { rel = assertRepoPath(q.path).rel; args.push('--', rel); }
  const r = await git(args);
  const MAXOUT = 20000;
  let text = r.stdout;
  const truncated = text.length > MAXOUT;
  if (truncated) text = text.slice(0, MAXOUT) + '\n…（差异过长已截断，可加 path 参数缩小范围）';
  return { text, truncated, command: 'git ' + args.join(' ') };
}
/* 分支定死 main（2026-10-27）：AI 的 git_branch 只保留 list；create/switch 已删——
   本地切走会让按 main 同步的流程错乱 */
async function gitBranchOp() {
  ensureReady();
  const r = await git(['branch', '--format=%(refname:short)\t%(objectname:short)\t%(HEAD)']);
  const branches = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const p = l.split('\t');
    return { name: p[0], hash: p[1] || '', current: (p[2] || '').trim() === '*' };
  });
  return { branches, remote: config.remote || '' };
}
async function gitRestoreFiles(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
  const commit = String((body && body.commit) || '');
  if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) throw httpError(400, 'commit 无效');
  const paths = Array.isArray(body && body.paths) ? body.paths.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (!paths.length || paths.length > 200) throw httpError(400, 'paths 须为 1~200 个路径');
  const rels = paths.map((p) => assertRepoPath(p).rel);
  return enqueueWrite(async () => {
    /* checkout <commit> -- paths：恢复到工作区并同时更新暂存区；是否提交由用户经 git_commit 决定 */
    const r = await git(['checkout', commit, '--'].concat(rels));
    if (r.code !== 0) throw new Error('恢复失败（该提交中可能不存在这些文件）：' + (r.stderr || '').trim().split('\n')[0]);
    clearPyCache();
    return { restored: rels, commit, note: '已恢复到工作区并暂存，尚未提交；确认无误后用 git_commit 提交' };
  });
}

/* ================= 仓库统一设置 settings/main.json（version:1，收编原 tags.json/ai.json） =================
   读不到就创建；旧 settings/tags.json 与 settings/ai.json 在首次读取时一次性收编进 main.json
   （只迁数据不提交，提交随下一次设置写操作落地），此后只认 main.json，version!==1 拒读走默认。 */
const MAIN_JSON = 'settings/main.json';
/* AI 配置规范化：key 明文入仓是用户知情的选择（多端免配置），远端仓库须可信；服务端只做规范化，不落日志。 */
function validAiConfig(cfg) {
  const extra = cfg && cfg.extra && typeof cfg.extra === 'object' && !Array.isArray(cfg.extra) ? cfg.extra : null;
  return {
    baseURL: String((cfg && cfg.baseURL) || '').trim().replace(/\/+$/, '').slice(0, 300),
    apiKey: String((cfg && cfg.apiKey) || '').slice(0, 300),
    model: String((cfg && cfg.model) || '').trim().slice(0, 100),
    extra,
  };
}
function defaultMain() {
  return { version: 1, tags: DEFAULT_TAGS.slice(), pins: [], ai: validAiConfig(null) };
}
/* AI 提供商预设：远端 JSON（OSS 托管，可随时更新）→ 内存缓存；拉取失败/不合法回退内置清单。
   前端 CSP connect-src 'self' 不放宽，故由服务端代理读取，端点 /api/ai/providers（三端同语义）。 */
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
  /* 失败兜底也缓存，但只缓存 5 分钟，避免网络恢复后长时间拿到旧兜底 */
  if (aiProvidersCache.data && aiProvidersCache.data.builtin && now - aiProvidersCache.failAt < 300e3) return aiProvidersCache.data;
  aiProvidersCache = { okAt: 0, failAt: now, data: { version: 1, builtin: true, providers: BUILTIN_AI_PROVIDERS.slice() } };
  return aiProvidersCache.data;
}
function writeMainRaw(o) {
  fs.writeFileSync(path.join(REPO_DIR, MAIN_JSON), JSON.stringify(o, null, 2) + '\n');
}
function normalizeMain(o) {
  return {
    version: 1,
    tags: Array.isArray(o.tags) ? o.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 16)) : DEFAULT_TAGS.slice(),
    pins: Array.isArray(o.pins) ? o.pins.filter((p) => typeof p === 'string' && /^micro\/\d{4}\/\d{2}\/[A-Za-z0-9._-]+\.md$/.test(p)) : [],
    ai: validAiConfig(o.ai),
  };
}
function readMain() {
  let raw = null;
  try { raw = fs.readFileSync(path.join(REPO_DIR, MAIN_JSON), 'utf8'); } catch (_) {}
  if (raw !== null) {
    /* 已有 main.json：解析失败或 version!==1 一律报错（为将来兼容留钩子），不走迁移 */
    let o = null;
    try { o = JSON.parse(raw); } catch (_) { throw httpError(500, 'main.json 解析失败'); }
    if (!o || typeof o !== 'object' || o.version !== 1) throw httpError(500, 'main.json version 非法');
    return normalizeMain(o);
  }
  /* 一次性收编旧配置（存量数据不丢）；写盘不提交，待下次设置写操作一并提交 */
  const m = defaultMain();
  try {
    const a = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'settings/tags.json'), 'utf8'));
    if (Array.isArray(a)) m.tags = a.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 16));
  } catch (_) {}
  try {
    m.ai = validAiConfig(JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'settings/ai.json'), 'utf8')));
  } catch (_) {}
  try { writeMainRaw(m); } catch (_) {}
  return m;
}
async function writeMain(mutate, msg) {
  ensureReady();
  await writePreSync();
  const cur = readMain();
  mutate(cur);
  fs.mkdirSync(path.join(REPO_DIR, 'settings'), { recursive: true });
  writeMainRaw(cur);
  await gitOk(['add', '--', MAIN_JSON]);
  const st = await git(['commit', '-m', msg]);
  if (st.code === 0 && config.remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
  return cur;
}
function readTags() {
  return readMain().tags;
}

async function writeTags(tags, action, tag) {
  let list;
  let msg = 'settings: init';
  if (action === 'add' && tag) msg = 'settings: add tag ' + tag;
  else if (action === 'remove' && tag) msg = 'settings: remove tag ' + tag;
  const r = await writeMain((m) => {
    const cur = m.tags;
    if (action === 'add' && tag) list = cur.indexOf(tag) > -1 ? cur : cur.concat([tag]);
    else if (action === 'remove' && tag) list = cur.filter((x) => x !== tag);
    else { list = validTags(tags); msg = 'settings: init'; }
    m.tags = list;
  }, msg);
  return r.tags;
}

/* ================= 钉住清单：main.json 的 pins（path 数组，上限 9） ================= */
const MAX_PINS = 9;
async function setPin({ path: rel, pinned }) {
  ensureReady();
  await writePreSync();
  assertPostPath(rel);
  if (!fs.existsSync(path.join(REPO_DIR, rel))) throw httpError(404, '笔记不存在（可能已在其他设备删除）');
  const summary = summarize(readPost(rel).text, 0);
  const r = await writeMain((m) => {
    const has = m.pins.indexOf(rel) > -1;
    if (pinned && !has) {
      if (m.pins.length >= MAX_PINS) throw httpError(400, '最多钉住 ' + MAX_PINS + ' 篇笔记');
      m.pins = m.pins.concat([rel]);
    } else if (!pinned && has) {
      m.pins = m.pins.filter((p) => p !== rel);
    }
  }, (pinned ? 'settings: pin ' : 'settings: unpin ') + summary);
  return r.pins;
}

/* ================= 读操作：按月列举与全库搜索 ================= */

function listMonths() {
  const out = [];
  const yearsRoot = path.join(REPO_DIR, 'micro');
  let years = [];
  try { years = fs.readdirSync(yearsRoot).filter((y) => /^\d{4}$/.test(y)).sort().reverse(); } catch (_) { return out; }
  for (const y of years) {
    let months = [];
    try { months = fs.readdirSync(path.join(yearsRoot, y)).filter((mm) => /^\d{2}$/.test(mm)).sort().reverse(); } catch (_) { continue; }
    for (const mm of months) out.push(y + mm);
  }
  return out;
}
function monthHasPosts(ym) {
  const d = path.join(REPO_DIR, 'micro', ym.slice(0, 4), ym.slice(4));
  try {
    return fs.readdirSync(d).some((f) => /\.md$/.test(f));
  } catch (_) { return false; }
}
function listPosts(ym) {
  const d = path.join(REPO_DIR, 'micro', ym.slice(0, 4), ym.slice(4));
  let mds = [];
  try {
    mds = fs.readdirSync(d).filter((f) => /\.md$/.test(f)).map((f) => 'micro/' + ym.slice(0, 4) + '/' + ym.slice(4) + '/' + f);
  } catch (_) { return []; }
  return mds.map((p) => { try { return readPost(p); } catch (_) { return null; } }).filter(Boolean)
    .sort((a, b) => b.stem.localeCompare(a.stem));
}
function pagePosts(before) {
  const months = listMonths();
  let pool = months;
  if (before) {
    if (!/^\d{6}$/.test(before)) throw httpError(400, 'before 须为 YYYYMM');
    pool = months.filter((mm) => mm < before);
  }
  const ym = pool.find(monthHasPosts);
  if (!ym) return { month: null, posts: [], more: false };
  const idx = months.indexOf(ym);
  /* 钉住帖随每次分页响应全量返回（来源 main.json pins，读单文件非全库扫描）；磁盘上已不存在的静默剔除 */
  const pins = readMain().pins
    .filter((p) => { try { return fs.existsSync(path.join(REPO_DIR, p)); } catch (_) { return false; } })
    .map((p) => { try { return readPost(p); } catch (_) { return null; } })
    .filter(Boolean);
  return { month: ym, posts: listPosts(ym), pins, more: months.slice(idx + 1).some(monthHasPosts) };
}

/* ================= 拼音索引（全库搜索支持拼音/首字母） =================
   每帖缓存 {full: 全拼串, initials: 首字母串}：汉字转音节、其余字符原样保留。
   写操作与同步后清缓存（内容可能已变）。 */
const pyCache = new Map();
function clearPyCache() { pyCache.clear(); }
function pyIndexOf(p) {
  let e = pyCache.get(p.path);
  if (e) return e;
  const hay = p.text + '\n' + p.tags.join(' ');
  let full = '', initials = '';
  for (const ch of hay) {
    const py = charPinyin[ch];
    if (py) { full += py; initials += py[0]; }
    else { full += ch; initials += ch; }
  }
  e = { full: full.toLowerCase(), initials: initials.toLowerCase() };
  pyCache.set(p.path, e);
  return e;
}

function searchAll(q) {
  const t0 = Date.now();
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], total: 0, ms: 0 };
  const hits = [];
  let total = 0;
  const LIMIT = 200;
  for (const ym of listMonths()) {
    for (const p of listPosts(ym)) {
      total++;
      const hay = (p.text + '\n' + p.tags.join(' ')).toLowerCase();
      const py = pyIndexOf(p);
      if (!terms.every((t) => hay.indexOf(t) > -1 || py.full.indexOf(t) > -1 || py.initials.indexOf(t) > -1)) continue;
      hits.push(p);
      if (hits.length >= LIMIT) break;
    }
    if (hits.length >= LIMIT) break;
  }
  return { hits, total, ms: Date.now() - t0 };
}

/* ================= AI 代理：浏览器统一经本机服务转发 AI 请求并透传流式响应 =================
   部分服务商不支持浏览器跨域（如智谱不回 Access-Control-Allow-Origin），同源代理对前端零差别。
   url/key 来自本机页面的 localStorage（随请求体传入，不落盘不落日志）；服务端 fetch 无 CORS。
   流式透传：Readable.fromWeb 逐块 pipe（自带写即走，不缓冲整包），SSE 逐帧到达。 */
async function aiProxy(res, body) {
  const target = String((body && body.url) || '');
  if (!/^https?:\/\//.test(target) || target.length > 2000) throw httpError(400, 'url 非法');
  let up;
  try {
    up = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String((body && body.key) || ''), 'Accept-Encoding': 'identity' },
      body: JSON.stringify((body && body.body) || {})
    });
  } catch (e) {
    throw httpError(502, '上游连接失败：' + e.message);
  }
  res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (!up.body) { res.end(); return; }
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

/* ================= 通用 HTTP 请求端点（AI 工具 http_request / web_fetch 的服务端执行器） =================
   请求在本机服务端发出（Node fetch 无 CORS）；手动跟随重定向，每跳重新校验目标主机，拒绝内网地址（防 SSRF）。
   响应整体读入但按 max_bytes 截断（不落盘）；字符集按 Content-Type 解码（中文站常见 GBK）。 */

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
  if (!/^https?:\/\//i.test(urlStr) || urlStr.length > 2000) throw httpError(400, 'url 非法（仅支持 http/https）');
  const method = String((body && body.method) || 'GET').toUpperCase();
  if (HTTP_METHODS.indexOf(method) === -1) throw httpError(400, 'method 不支持：' + method);
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
    try { u = new URL(current); } catch (_) { throw httpError(400, 'url 解析失败：' + current); }
    if (httpPrivateHost(u.hostname)) throw httpError(400, '拒绝访问内网地址：' + u.hostname);
    try {
      res = await fetch(current, {
        method: method,
        headers: reqHeaders,
        body: bodyStr,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw httpError(502, '请求失败：' + ((e && e.message) || e));
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try { if (res.body) res.body.cancel(); } catch (_) {}
      if (++redirects > 5) throw httpError(508, '重定向次数超限（>5）');
      try { current = new URL(loc, current).href; } catch (_) { throw httpError(400, '重定向地址非法：' + loc); }
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

/* ================= 联网搜索端点（AI 工具 web_search 的服务端执行器） =================
   转发 Firecrawl Search API（https://api.firecrawl.dev/v2/search，对齐 vtxf-firecrawl-search 技能）。
   默认匿名（keyless）调用，免费但有日配额；前端传入 api_key 时附 Bearer 头提升配额。
   本端点恒返回 200 JSON：{ ok:true, auth, results } 或 { ok:false, quota_exceeded, error }，
   由前端把配额问题转述为「引导用户提供 API Key」的话术。 */

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

/* ================= HTTP 服务 ================= */

/* CSP：前端已拆分为 /assets/app.css 与 /js/*.js，脚本样式放行同源（self）。
   style-src 保留 unsafe-inline：页面仍用 style 属性与 JS 内联样式 */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

/* 静态文件（仅 assets/ 与 js/ 两个白名单目录，防目录穿越） */
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function serveStatic(req, urlPath, res) {
  const rel = decodeURIComponent(urlPath.slice(1));
  if (!/^(assets|js)\/[A-Za-z0-9._-]+$/.test(rel)) { sendJson(res, 404, { error: 'not found' }); return; }
  const abs = path.join(__dirname, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { sendJson(res, 404, { error: 'not found' }); return; }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(abs)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(fs.readFileSync(abs));
  log(req, 200);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 300 * 1024 * 1024) { reject(httpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function jsonBody(buf) {
  if (!buf || !buf.length) return {};   /* 无体 POST（如 /api/sync、/api/repo/open）按空对象处理 */
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw httpError(400, 'JSON 解析失败'); }
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function authOk(req) {
  const cookies = String(req.headers.cookie || '').split(/;\s*/);
  const tok = cookies.map((c) => c.split('=')).find((kv) => kv[0] === 'gn_token');
  return tok && tok[1] === PAGE_TOKEN;
}
function hostOk(req) {
  const h = String(req.headers.host || '');
  return h === `${HOST}:${PORT}` || h === `localhost:${PORT}`;
}
function log(req, status) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url.split('?')[0]} -> ${status}`);
}

async function route(req, res) {
  const urlPath = req.url.split('?')[0];
  const query = new URLSearchParams(req.url.split('?')[1] || '');
  if (!hostOk(req)) { sendJson(res, 403, { error: 'Host 不合法' }); return; }
  if (req.method === 'GET' && urlPath === '/assets/version.json') {
    /* 必须先于静态分支：web 源码树内无此文件，由启动时现算的 APP_VERSION 虚拟提供 */
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(APP_VERSION));
    log(req, 200);
    return;
  }
  if (req.method === 'GET' && (urlPath.startsWith('/assets/') || urlPath.startsWith('/js/'))) {
    serveStatic(req, urlPath, res);
    return;
  }
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-store',
      'Set-Cookie': `gn_token=${PAGE_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
    });
    res.end(fs.readFileSync(INDEX));
    log(req, 200);
    return;
  }
  if (req.method === 'GET' && urlPath === '/help.html') {
    /* 帮助独立页：静态文档不调 API、无 cookie 需求，仍带 CSP */
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(path.join(__dirname, 'help.html')));
    log(req, 200);
    return;
  }
  if (urlPath === '/healthz') {
    sendJson(res, 200, { ok: true, version: VERSION, pid: process.pid });
    log(req, 200);
    return;
  }
  if (urlPath.startsWith('/media/') && req.method === 'GET') {
    if (!authOk(req)) { sendJson(res, 401, { error: '未授权' }); return; }
    const rel = decodeURIComponent(urlPath.slice('/media/'.length));
    if (!/^micro\/[A-Za-z0-9._/\-]+$/.test(rel) || rel.includes('..')) { sendJson(res, 400, { error: '非法路径' }); return; }
    const abs = path.join(REPO_DIR, rel);
    if (!abs.startsWith(path.join(REPO_DIR, 'micro') + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const ext = (rel.match(/\.([a-zA-Z0-9]+)$/) || [])[1].toLowerCase();
    const diskName = rel.split('/').pop();
    const headers = { 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
    if (IMG_MIME[ext]) {
      headers['Content-Type'] = IMG_MIME[ext];   /* 图片维持内联（卡片/灯箱 <img> 依赖） */
    } else {
      /* 非图片一律 attachment 下载：防同源 html/svg 执行窃取 cookie，nosniff 防 MIME 嗅探 */
      headers['Content-Type'] = FILE_MIME[ext] || 'application/octet-stream';
      headers['Content-Disposition'] = 'attachment; filename="' + diskName.replace(/[^A-Za-z0-9._-]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(diskName);
    }
    res.writeHead(200, headers);
    res.end(fs.readFileSync(abs));
    log(req, 200);
    return;
  }
  if (urlPath.startsWith('/api/')) {
    if (!authOk(req)) { sendJson(res, 401, { error: '页面凭证失效，请刷新页面' }); return; }
    try {
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? jsonBody(await readBody(req)) : null;
      let out = null;
      if (urlPath === '/api/status') {
        out = {
          version: VERSION,
          stage: stage(),
          platform: process.platform,
          remote: config.remote || '',
          branch: hasRepo() ? MAIN_BRANCH : '',
          key: { exists: fs.existsSync(KEY_FILE), pubKey: fs.existsSync(PUB_FILE) ? fs.readFileSync(PUB_FILE, 'utf8').trim() : '' },
          clone: { active: cloneState.active, phase: cloneState.phase, progress: cloneState.progress, error: cloneState.error },
          sync: { busy: syncState.busy || writeBusy, phase: syncState.phase, lastError: syncState.lastError, conflict: syncState.conflict, lastAt: syncState.lastAt, ahead: syncState.ahead, behind: syncState.behind },
        };
      } else if (urlPath === '/api/update/check' && req.method === 'GET') {
        /* web 版无独立安装包形态（随仓库运行，git pull 即更新），仅报告当前版本 */
        out = { supported: false, current: VERSION, latest: null, updateAvailable: false, url: '' };
      } else if (urlPath === '/api/setup/local' && req.method === 'POST') {
        out = await setupLocal();
      } else if (urlPath === '/api/setup/key' && req.method === 'POST') {
        out = { pubKey: await ensureKey() };
      } else if (urlPath === '/api/setup/key/rotate' && req.method === 'POST') {
        out = await rotateKey();
      } else if (urlPath === '/api/setup/key/import' && req.method === 'POST') {
        out = await importKey(body ? body.privateKey : '');
      } else if (urlPath === '/api/setup/key/private' && req.method === 'POST') {
        out = readPrivateKey();
      } else if (urlPath === '/api/setup/clone' && req.method === 'POST') {
        out = await startClone(body ? body.remote : '');
      } else if (urlPath === '/api/bind/connect' && req.method === 'POST') {
        out = await enqueueWrite(() => bindConnect(body ? body.remote : ''));
      } else if (urlPath === '/api/unbind' && req.method === 'POST') {
        out = await unbind();
      } else if (urlPath === '/api/sync' && req.method === 'POST') {
        if (syncState.busy || writeBusy) throw httpError(409, '同步或写入进行中');
        out = await doSync();
      } else if (urlPath === '/api/repo/open' && req.method === 'POST') {
        out = await openRepo();
      } else if (urlPath === '/api/force-push' && req.method === 'POST') {
        if (syncState.busy || writeBusy) throw httpError(409, '同步或写入进行中');
        out = await enqueueWrite(() => forcePush());
      } else if (urlPath === '/api/remote-overwrite' && req.method === 'POST') {
        if (syncState.busy || writeBusy) throw httpError(409, '同步或写入进行中');
        out = await enqueueWrite(() => remoteOverwrite());
      } else if (urlPath === '/api/posts' && req.method === 'GET') {
        ensureReady();
        out = pagePosts(query.get('before') || '');
      } else if (urlPath === '/api/posts' && req.method === 'POST') {
        if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
        out = await enqueueWrite(() => writePost(body));
      } else if (urlPath === '/api/posts' && req.method === 'PUT') {
        if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
        out = await enqueueWrite(() => updatePost(body));
      } else if (urlPath === '/api/posts/pin' && req.method === 'POST') {
        if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
        out = await enqueueWrite(() => setPin({ path: body ? body.path : '', pinned: !!(body && body.pinned) }));
      } else if (urlPath === '/api/posts' && req.method === 'DELETE') {
        if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
        out = await enqueueWrite(() => deletePost(body));
      } else if (urlPath === '/api/tags' && req.method === 'GET') {
        ensureReady();
        out = { tags: readTags() };
      } else if (urlPath === '/api/tags' && req.method === 'PUT') {
        if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
        out = await enqueueWrite(() => writeTags(body.tags, body.action, body.tag));
      } else if (urlPath === '/api/search' && req.method === 'GET') {
        ensureReady();
        out = searchAll(query.get('q') || '');
      } else if (urlPath === '/api/git/log' && req.method === 'GET') {
        ensureReady();
        out = await gitLog({ limit: query.get('limit'), path: query.get('path') || '' });
      } else if (urlPath === '/api/git/show' && req.method === 'GET') {
        ensureReady();
        out = await gitShow({ path: query.get('path') || '', commit: query.get('commit') || '' });
      } else if (urlPath === '/api/git/restore' && req.method === 'POST') {
        if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
        out = await enqueueWrite(() => gitRestore(body));
      } else if (urlPath === '/api/ai/proxy' && req.method === 'POST') {
        await aiProxy(res, body);   // 直接写响应（流式），不走 sendJson
        log(req, 200);
        return;
      } else if (urlPath === '/api/ai/settings' && req.method === 'GET') {
        out = readMain().ai;
      } else if (urlPath === '/api/ai/settings' && req.method === 'POST') {
        if (syncState.busy || writeBusy) throw httpError(409, '已有写操作进行中，请稍候');
        out = await enqueueWrite(async () => { await writeMain((m) => { m.ai = validAiConfig(body); }, 'settings: set ai'); return readMain().ai; });
      } else if (urlPath === '/api/ai/providers' && req.method === 'GET') {
        out = await aiProviders();
      } else if (urlPath === '/api/http/request' && req.method === 'POST') {
        out = await httpRequestTool(body);
      } else if (urlPath === '/api/web/search' && req.method === 'POST') {
        out = await webSearchTool(body);
      } else if (urlPath === '/api/fs/list' && req.method === 'GET') {
        out = fsList(query.get('path') || '');
      } else if (urlPath === '/api/fs/read' && req.method === 'GET') {
        out = fsRead(query.get('path') || '');
      } else if (urlPath === '/api/fs/write' && req.method === 'POST') {
        out = await fsWrite(body);
      } else if (urlPath === '/api/fs/delete' && req.method === 'POST') {
        out = await fsDelete(body);
      } else if (urlPath === '/api/fs/move' && req.method === 'POST') {
        out = await fsMove(body);
      } else if (urlPath === '/api/fs/mkdir' && req.method === 'POST') {
        out = await fsMkdir(body);
      } else if (urlPath === '/api/git/status' && req.method === 'GET') {
        out = await gitStatus();
      } else if (urlPath === '/api/git/add' && req.method === 'POST') {
        out = await gitAdd(body);
      } else if (urlPath === '/api/git/commit' && req.method === 'POST') {
        out = await gitCommit(body);
      } else if (urlPath === '/api/git/push' && req.method === 'POST') {
        out = await gitPush();
      } else if (urlPath === '/api/git/pull' && req.method === 'POST') {
        out = await gitPull();
      } else if (urlPath === '/api/git/diff' && req.method === 'GET') {
        out = await gitDiff({ from: query.get('from') || '', to: query.get('to') || '', path: query.get('path') || '', mode: query.get('mode') || '' });
      } else if (urlPath === '/api/git/branch' && req.method === 'POST') {
        out = await gitBranchOp(body);
      } else if (urlPath === '/api/git/restore-files' && req.method === 'POST') {
        out = await gitRestoreFiles(body);
      } else {
        throw httpError(404, 'not found');
      }
      sendJson(res, 200, out);
      log(req, 200);
    } catch (e) {
      const status = e.status || 500;
      const payload = { error: String(e.message || e) };
      if (e.conflict) payload.conflict = e.conflict;
      if (e.needPubKey) payload.needPubKey = true;
      sendJson(res, status, payload);
      log(req, status);
    }
    return;
  }
  sendJson(res, 404, { error: 'not found' });
  log(req, 404);
}

/* ================= 启动 ================= */

const PID_FILE = path.join(HOME_DIR, 'git-notes.pid');

function cleanupPid() {
  try {
    const pf = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (pf.pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch (_) { /* 无记录或已清理 */ }
}

process.on('SIGTERM', () => { process.exit(0); });
process.on('SIGINT', () => { process.exit(0); });
process.on('exit', cleanupPid);
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && (e.stack || e.message || e));
});

(async () => {
  const ok = await checkGitAvailable();
  if (!ok) {
    console.error('[error] 未检测到 git。请安装 Git for Windows 后重试。');
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      try { sendJson(res, 500, { error: String(e.message || e) }); } catch (_) {}
    });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[error] 端口 ${PORT} 已被占用（可能已有一个实例在运行）：http://127.0.0.1:${PORT}`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(PORT, HOST, () => {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid,
      port: PORT,
      version: VERSION,
      startedAt: new Date().toISOString(),
    }));
    console.log(`[git-notes] v${VERSION} 服务已启动：http://${HOST}:${PORT}${config.remote ? '（远端 ' + config.remote + '）' : '（仅本机模式）'}`);
  });
})();
