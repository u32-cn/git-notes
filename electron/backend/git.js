// git 层：spawn 系统 git/ssh-keygen、SSH 专用密钥、状态机(fresh/local/ready/cloning)、
// 同步策略(rebase→merge→冲突 abort)、绑定三况、克隆、写队列。
// 语义对齐 web/server.js（改动 server.js 对应行为时需手工同步本文件，义务见 AGENTS.md）。

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const store = require('./store');
const { HOME_DIR, KEY_DIR, KEY_FILE, PUB_FILE, KNOWN_HOSTS, REPO_DIR } = store;
const { appError } = store;

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

const cloneState = { active: false, phase: '', progress: 0, error: '' };
const syncState = { busy: false, phase: '', lastError: '', conflict: null, lastAt: null, ahead: 0, behind: 0 };

function stage() {
  if (cloneState.active) return 'cloning';
  if (!hasRepo()) return 'fresh';
  if (!store.getConfig().remote) return 'local';
  return 'ready';
}

function conflictError(files) {
  const e = new Error('存在无法自动合并的冲突：' + files.join('、'));
  e.status = 409;
  e.conflict = files;
  return e;
}

/* 同步策略：优先 rebase，其次 merge；仍冲突则进入「冲突待处理」 */
async function integrateRemote() {
  let r = await git(['rebase', 'origin/' + store.MAIN_BRANCH]);
  if (r.code === 0) return;
  await git(['rebase', '--abort']);
  // 绑定/同步语义允许叠加无关历史（git 默认拒绝，需显式放行）；放行后仍冲突才走冲突路径
  r = await git(['merge', '--allow-unrelated-histories', 'origin/' + store.MAIN_BRANCH]);
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
    const p = await git(['push', 'origin', store.MAIN_BRANCH], { timeout: 300000 });
    if (p.code === 0) { syncState.ahead = 0; syncState.conflict = null; return; }
    await gitOk(['fetch', 'origin'], { timeout: 300000 });
    syncState.phase = '整合远端重试 ' + (i + 1);
    await integrateRemote();
  }
  throw new Error('推送失败：远端持续有新提交，请稍后手动同步重试。');
}

async function doSync() {
  if (!store.getConfig().remote) return { local: true, ahead: 0, behind: 0 };
  syncState.busy = true;
  syncState.lastError = '';
  try {
    syncState.phase = '获取远端';
    await gitOk(['fetch', 'origin'], { timeout: 300000 });
    const br = store.MAIN_BRANCH;
    // 远端还没有本地分支（如本地刚改名分支）时：ahead=全部本地提交，behind=0，推送会在远端建立新分支
    const hasRemoteRef = (await git(['rev-parse', '--verify', '--quiet', 'origin/' + br])).code === 0;
    let ahead = 0, behind = 0;
    if (hasRemoteRef) {
      const cnt = await gitOk(['rev-list', '--left-right', '--count', `${br}...origin/${br}`]);
      [ahead, behind] = cnt.stdout.trim().split(/\s+/).map(Number);
    } else {
      ahead = parseInt((await git(['rev-list', '--count', 'HEAD'])).stdout.trim() || '0', 10);
    }
    syncState.ahead = ahead; syncState.behind = behind;
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
    store.clearPyCache();   /* 同步后远端内容可能已并入，拼音索引失效 */
  }
}

let writeQueue = Promise.resolve();
let writeBusy = false;
function enqueueWrite(fn) {
  writeBusy = true;
  const p = writeQueue.then(fn);
  writeQueue = p.catch(() => {});          /* 队列链吞掉拒绝，避免未处理拒绝 */
  p.catch(() => {}).finally(() => { writeBusy = false; store.clearPyCache(); });   /* 写后拼音索引失效 */
  return p;
}

/* ================= 首次配置：仅本机 init / 克隆远端 ================= */

async function ensureAuthor() {
  const repoName = (await git(['config', 'user.name'])).stdout.trim();
  if (repoName) return;
  const globName = (await git(['config', '--global', 'user.name'])).stdout.trim();
  const globMail = (await git(['config', '--global', 'user.email'])).stdout.trim();
  if (globName && globMail) return;
  await gitOk(['config', 'user.name', globName || 'git-notes']);
  await gitOk(['config', 'user.email', globMail || 'git-notes@local']);
}

async function setupLocal() {
  if (hasRepo()) return { ready: true };
  fs.mkdirSync(REPO_DIR, { recursive: true });
  await gitOk(['init', '-b', 'main'], { cwd: REPO_DIR });
  await ensureAuthor();
  fs.mkdirSync(path.join(REPO_DIR, 'settings'), { recursive: true });
  store.writeMainRaw(store.defaultMain());
  await gitOk(['add', '--', store.MAIN_JSON]);
  await gitOk(['commit', '-m', 'settings: init']);
  store.saveConfig({ remote: '' });
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
  if (r) throw appError(500, r);
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) {}
  return fs.readFileSync(PUB_FILE, 'utf8').trim();
}

/* 密钥泄漏时的用户自救：删除旧密钥对并重新生成（旧公钥在 git 服务器上立即失效） */
async function rotateKey() {
  if (syncState.busy || writeBusy) throw appError(409, '同步或写入进行中');
  try { fs.unlinkSync(KEY_FILE); } catch (_) {}
  try { fs.unlinkSync(PUB_FILE); } catch (_) {}
  const pubKey = await ensureKey();
  return { pubKey, rotated: true };
}

/* 导入用户已有私钥（OpenSSH 格式、无口令；任意算法类型）：派生公钥校验通过后才落地覆盖 */
async function importKey(privateKey) {
  if (syncState.busy || writeBusy) throw appError(409, '同步或写入进行中');
  const raw = String(privateKey || '').replace(/\r\n/g, '\n').trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----$/.test(raw.split('\n')[0] || '')) {
    throw appError(400, '不是 OpenSSH 私钥：内容需以 -----BEGIN … PRIVATE KEY----- 开头');
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
    throw appError(400, '私钥无效或带口令：仅支持无口令的 OpenSSH 格式私钥');
  }
  fs.renameSync(tmp, KEY_FILE);
  fs.writeFileSync(PUB_FILE, pub + '\n');
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) {}
  return { pubKey: pub, imported: true };
}

function readPrivateKey() {
  if (!fs.existsSync(KEY_FILE)) throw appError(404, '本机尚无 SSH 私钥');
  return { privateKey: fs.readFileSync(KEY_FILE, 'utf8') };
}

/* ================= 克隆远端（fresh → ready） ================= */

async function startClone(remote) {
  if (cloneState.active) throw appError(409, '克隆正在进行中');
  if (hasRepo()) throw appError(409, '本地已存在仓库（如需重新克隆请先删除 ' + REPO_DIR + '）');
  if (!remote) throw appError(400, '缺少远端地址');
  if (store.isSshRemote(remote)) await ensureKey();
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
      store.saveConfig({ remote });
      try {
        /* 分支定死 main：远端 HEAD 可能指向别的分支（如老仓库的 master），克隆后统一改名对齐 */
        const cur = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
        if (cur && cur !== store.MAIN_BRANCH) await gitOk(['branch', '-m', cur, store.MAIN_BRANCH]);
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

/* ================= 绑定远端（local → ready） ================= */

async function bindProbe(remote) {
  if (!remote || /\s/.test(remote)) throw appError(400, '远端地址不能为空且不能含空格');
  let needKey = false;
  if (store.isSshRemote(remote) && !fs.existsSync(KEY_FILE)) {
    await ensureKey();
    needKey = true;
  }
  const r = await git(['ls-remote', remote], { timeout: 120000 });
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').pop() || 'ls-remote 失败';
    const e = appError(400, '远端不可达：' + msg);
    if (needKey || /permission denied|publickey/i.test(r.stderr)) e.needPubKey = true;
    throw e;
  }
  // 空仓时输出为空；分支定死 main，不关心远端 HEAD 指向
  return { ok: true, empty: r.stdout.trim() === '', needPubKey: needKey };
}

async function getOriginUrl() {
  const r = await git(['remote', 'get-url', 'origin']);
  return r.code === 0 ? r.stdout.trim() : '';
}

async function bindConfirm(remote) {
  if (stage() !== 'local') throw appError(409, '仅「仅本机使用」模式可绑定远端');
  await bindProbe(remote);
  await ensureAuthor();
  const hasOrigin = (await git(['remote'])).stdout.split(/\r?\n/).includes('origin');
  if (hasOrigin) await gitOk(['remote', 'remove', 'origin']);
  await gitOk(['remote', 'add', 'origin', remote]);
  await gitOk(['fetch', 'origin'], { timeout: 300000 });
  // 分支定死 main：本地不在 main 就改名迁移（老仓库兼容），不再对齐远端 HEAD
  const cur = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (cur && cur !== store.MAIN_BRANCH) await gitOk(['branch', '-m', cur, store.MAIN_BRANCH]);
  const remoteHasMain = (await git(['ls-remote', 'origin', store.MAIN_BRANCH])).stdout.trim() !== '';
  const localCount = parseInt((await git(['rev-list', '--count', 'HEAD'])).stdout.trim() || '0', 10);
  if (!remoteHasMain) {
    // 远端没有 main（空仓或远端默认分支是 master 等旧分支）：本地 main 直接推上去建立
    await gitOk(['push', '-u', 'origin', store.MAIN_BRANCH], { timeout: 300000 });
    store.saveConfig({ remote });
    return { bound: true, mode: 'empty-remote-pushed' };
  }
  if (localCount === 0) {
    // 本地无提交：直接采用远端内容
    await gitOk(['reset', '--hard', 'origin/' + store.MAIN_BRANCH]);
    store.saveConfig({ remote });
    return { bound: true, mode: 'fast-forward' };
  }
  // 双方都有历史：返回预览，待用户确认合并
  const remoteCount = parseInt((await git(['rev-list', '--count', 'origin/' + store.MAIN_BRANCH])).stdout.trim() || '0', 10);
  return { pendingMerge: true, branch: store.MAIN_BRANCH, localCount, remoteCount };
}

async function bindMerge() {
  if (stage() !== 'local') throw appError(409, '当前状态无可合并的绑定操作');
  if (!(await git(['remote'])).stdout.includes('origin')) throw appError(409, '尚未探测到远端');
  await integrateRemote();
  store.saveConfig({ remote: await getOriginUrl() });
  await gitOk(['push', '-u', 'origin', store.MAIN_BRANCH], { timeout: 300000 });
  syncState.conflict = null;
  syncState.lastAt = new Date().toISOString();
  return { bound: true, mode: 'merged' };
}

/* 绑定阶段合并冲突时的出口：以本地为准强制推送 */
async function bindForcePush() {
  if (stage() !== 'local') throw appError(409, '仅「仅本机使用」模式可在绑定时强制推送');
  if (!(await git(['remote'])).stdout.includes('origin')) throw appError(409, '尚未探测到远端');
  const p = await git(['push', '--force', '-u', 'origin', store.MAIN_BRANCH], { timeout: 300000 });
  if (p.code !== 0) throw new Error('强制推送失败：' + (p.stderr || p.stdout).trim().split('\n')[0]);
  store.saveConfig({ remote: await getOriginUrl() });
  syncState.conflict = null;
  syncState.lastAt = new Date().toISOString();
  return { bound: true, mode: 'force-pushed' };
}

async function cancelBind() {
  const hasOrigin = (await git(['remote'])).stdout.split(/\r?\n/).includes('origin');
  if (hasOrigin) await gitOk(['remote', 'remove', 'origin']);
  syncState.conflict = null;
  store.saveConfig({ remote: '' });
}

async function unbind() {
  if (stage() !== 'ready') throw appError(409, '当前未绑定远端');
  await cancelBind();
}

async function forcePush() {
  if (stage() !== 'ready') throw appError(409, '当前未绑定远端');
  const p = await git(['push', '--force', 'origin', store.MAIN_BRANCH], { timeout: 300000 });
  if (p.code !== 0) throw new Error('强制推送失败：' + (p.stderr || p.stdout).trim().split('\n')[0]);
  syncState.ahead = 0;
  syncState.conflict = null;
  syncState.lastError = '';
  syncState.lastAt = new Date().toISOString();
}

function ensureReady() {
  if (stage() !== 'ready' && stage() !== 'local') throw appError(409, '尚未完成首次配置');
}

/* ================= 写操作（路径白名单：micro/ 与 settings/tags.json） ================= */

/* 提交并按需推送：仅本机模式只 commit，绑定远端后 commit + push */
async function commitAndPush(paths, msg) {
  await gitOk(['add'].concat(['--'], paths));
  const st = await git(['commit', '-m', msg]);
  if (st.code !== 0) return; // 无实际变化
  if (store.getConfig().remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
}

async function writePreSync() {
  if (store.getConfig().remote) await doSync();
}

async function writePost({ text, tags, images, files, ai }) {
  ensureReady();
  await writePreSync();
  await ensureAuthor();
  const cleanTags = store.validTags(tags);
  const imgs = store.validImages(images);
  const fls = store.validFiles(files);
  const now = new Date();
  const dir = 'micro/' + now.getFullYear() + '/' + store.pad2(now.getMonth() + 1);
  fs.mkdirSync(path.join(REPO_DIR, dir), { recursive: true });
  const stem = store.tsOf(now);
  /* 附件磁盘名用 -fN 命名空间，与图片 -N 互不干扰（updatePost 的图片序号正则 -(d+). 不会误吞 -fN） */
  const names = imgs.map((im, i) => stem + '-' + (i + 1) + '.' + im.ext);
  const fileNames = fls.map((f, i) => stem + '-f' + (i + 1) + '.' + f.ext);
  const rel = dir + '/' + stem + '.md';
  const summary = store.summarize(text, imgs.length);
  if (fs.existsSync(path.join(REPO_DIR, rel))) throw appError(409, '同一秒内已有发布，请稍候 1 秒重试');
  fs.writeFileSync(path.join(REPO_DIR, rel), store.buildMicroMd(cleanTags, store.createdStr(now), names, String(text || ''), fls.map((f, i) => f.name + '|' + fileNames[i])));
  imgs.forEach((im, i) => fs.writeFileSync(path.join(REPO_DIR, dir, names[i]), im.buf));
  fls.forEach((f, i) => fs.writeFileSync(path.join(REPO_DIR, dir, fileNames[i]), f.buf));
  await commitAndPush([rel].concat(names.map((n) => dir + '/' + n), fileNames.map((n) => dir + '/' + n)), 'micro: add ' + summary + (ai ? ' [ai]' : ''));
  return { path: rel, name: stem + '.md', stem, dir, created: store.createdStr(now), tags: cleanTags, images: names, files: fls.map((f, i) => ({ name: f.name, path: fileNames[i] })), text: String(text || '').trim() };
}

async function updatePost({ path: rel, text, tags, keepNames, newImages, keepFileNames, newFiles, ai }) {
  ensureReady();
  await writePreSync();
  await ensureAuthor();
  store.assertPostPath(rel);
  if (!fs.existsSync(path.join(REPO_DIR, rel))) throw appError(404, '笔记不存在（可能已在其他设备删除）');
  const cur = store.readPost(rel);
  const cleanTags = store.validTags(tags);
  const keep = Array.isArray(keepNames) ? keepNames.filter((n) => typeof n === 'string' && cur.images.indexOf(n) > -1) : cur.images;
  const newImgs = store.validImages(newImages);
  if (keep.length + newImgs.length > store.MAX_IMAGES) throw appError(400, '最多 ' + store.MAX_IMAGES + ' 张图');
  const keepF = Array.isArray(keepFileNames)
    ? cur.files.filter((f) => keepFileNames.indexOf(f.path) > -1)
    : cur.files;
  const newFls = store.validFiles(newFiles);
  if (keepF.length + newFls.length > store.MAX_FILES) throw appError(400, '最多 ' + store.MAX_FILES + ' 个附件');
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
  const summary = store.summarize(text, keep.length + newImgs.length);
  fs.writeFileSync(path.join(REPO_DIR, rel), store.buildMicroMd(cleanTags, cur.created, keep.concat(names), String(text || ''), keepF.map((f) => f.name + '|' + f.path).concat(newFls.map((f, i) => f.name + '|' + fileNames[i]))));
  newImgs.forEach((im, i) => fs.writeFileSync(path.join(REPO_DIR, cur.dir, names[i]), im.buf));
  newFls.forEach((f, i) => fs.writeFileSync(path.join(REPO_DIR, cur.dir, fileNames[i]), f.buf));
  removed.concat(removedF).forEach((nm) => {
    const f = path.join(REPO_DIR, cur.dir, nm);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
  await gitOk(['add', '-A', '--', cur.dir]);
  const st = await git(['commit', '-m', 'micro: update ' + summary + (ai ? ' [ai]' : '')]);
  if (st.code === 0 && store.getConfig().remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
  return { path: rel, name: cur.name, stem: cur.stem, dir: cur.dir, created: cur.created, tags: cleanTags, images: keep.concat(names), files: keepF.map((f) => ({ name: f.name, path: f.path })).concat(newFls.map((f, i) => ({ name: f.name, path: fileNames[i] }))), text: String(text || '').trim() };
}

async function deletePost({ path: rel, ai }) {
  ensureReady();
  await writePreSync();
  store.assertPostPath(rel);
  if (!fs.existsSync(path.join(REPO_DIR, rel))) throw appError(404, '笔记不存在');
  const cur = store.readPost(rel);
  const summary = store.summarize(cur.text, cur.images.length);
  const files = [rel].concat(cur.images.map((nm) => cur.dir + '/' + nm), cur.files.map((f) => cur.dir + '/' + f.path));
  const r = await git(['rm', '-q', '--'].concat(files));
  if (r.code !== 0) {
    files.forEach((f) => { try { fs.unlinkSync(path.join(REPO_DIR, f)); } catch (_) {} });
    await gitOk(['add', '-A', '--', cur.dir]);
  }
  /* 钉住清单里的残留顺手清掉，与删除同一提交落地（对齐 server.js deletePost） */
  if (store.readMain().pins.indexOf(rel) > -1) {
    const m = store.readMain();
    m.pins = m.pins.filter((p) => p !== rel);
    store.writeMainRaw(m);
    await gitOk(['add', '--', store.MAIN_JSON]);
  }
  await gitOk(['commit', '-m', 'micro: delete ' + summary + (ai ? ' [ai]' : '')]);
  if (store.getConfig().remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
}

/* ================= git 历史（AI 工具用）：只读查阅 / 时点读取 / 恢复=新提交，绝不重写历史（对齐 server.js） ================= */
async function gitLog({ limit, path: rel }) {
  ensureReady();
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const args = ['log', '--max-count=' + n, '--date=iso-strict', '--format=%H%x09%ad%x09%s'];
  if (rel) { store.assertPostPath(rel); args.push('--', rel); }
  const r = await git(args);
  const commits = r.stdout.split('\n').filter(Boolean).map((line) => {
    const p = line.split('\t');
    return { hash: p[0] || '', date: p[1] || '', subject: p[2] || '' };
  }).filter((c) => c.hash);
  return { commits };
}
async function gitShow({ path: rel, commit }) {
  ensureReady();
  store.assertPostPath(rel);
  if (!/^[0-9a-fA-F]{7,40}$/.test(String(commit || ''))) throw appError(400, 'commit 无效');
  const r = await git(['show', commit + ':' + rel]);
  if (r.code !== 0) throw appError(404, '该提交中不存在此文件');
  return { text: r.stdout };
}
async function gitRestore({ path: rel, commit, ai }) {
  ensureReady();
  await writePreSync();
  await ensureAuthor();
  store.assertPostPath(rel);
  if (!/^[0-9a-fA-F]{7,40}$/.test(String(commit || ''))) throw appError(400, 'commit 无效');
  const r = await git(['show', commit + ':' + rel]);
  if (r.code !== 0) throw appError(404, '该提交中不存在此文件');
  /* 只恢复 md 本体；md 里引用的图片若已随删除提交移除，前端按 img-miss 展示 */
  fs.writeFileSync(path.join(REPO_DIR, rel), r.stdout);
  const cur = store.readPost(rel);
  await gitOk(['add', '--', rel]);
  const st = await git(['commit', '-m', 'micro: update ' + store.summarize(cur.text, cur.images.length) + (ai ? ' [ai]' : ' [restore]')]);
  if (st.code === 0 && store.getConfig().remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
  return { path: rel, restored: true };
}

/* ================= 统一设置写 main.json + 标签/钉住/AI 配置（对齐 server.js writeMain/writeTags/setPin） ================= */
async function writeMain(mutate, msg) {
  ensureReady();
  await writePreSync();
  const cur = store.readMain();
  mutate(cur);
  fs.mkdirSync(path.join(REPO_DIR, 'settings'), { recursive: true });
  store.writeMainRaw(cur);
  await gitOk(['add', '--', store.MAIN_JSON]);
  const st = await git(['commit', '-m', msg]);
  if (st.code === 0 && store.getConfig().remote) {
    syncState.phase = '推送';
    await pushWithRetry();
    syncState.lastAt = new Date().toISOString();
  }
  return cur;
}

async function writeTags(tags, action, tag) {
  let list;
  let msg = 'settings: init';
  if (action === 'add') msg = 'settings: add tag ' + tag;
  else if (action === 'remove') msg = 'settings: remove tag ' + tag;
  const r = await writeMain((m) => {
    const cur = m.tags;
    if (action === 'add' && tag) list = cur.indexOf(tag) > -1 ? cur : cur.concat([tag]);
    else if (action === 'remove' && tag) list = cur.filter((x) => x !== tag);
    else { list = store.validTags(tags); msg = 'settings: init'; }
    m.tags = list;
  }, msg);
  return r.tags;
}

/* 钉住清单：main.json 的 pins（path 数组，上限 MAX_PINS=9；对齐 server.js setPin） */
async function setPin({ path: rel, pinned }) {
  ensureReady();
  await writePreSync();
  store.assertPostPath(rel);
  if (!fs.existsSync(path.join(REPO_DIR, rel))) throw appError(404, '笔记不存在（可能已在其他设备删除）');
  const summary = store.summarize(store.readPost(rel).text, 0);
  const r = await writeMain((m) => {
    const has = m.pins.indexOf(rel) > -1;
    if (pinned && !has) {
      if (m.pins.length >= store.MAX_PINS) throw appError(400, '最多钉住 ' + store.MAX_PINS + ' 篇笔记');
      m.pins = m.pins.concat([rel]);
    } else if (!pinned && has) {
      m.pins = m.pins.filter((p) => p !== rel);
    }
  }, (pinned ? 'settings: pin ' : 'settings: unpin ') + summary);
  return r.pins;
}

const validAiConfig = store.validAiConfig;
function readAiSettings() {
  return store.readMain().ai;
}
async function setAiSettings(cfg) {
  const r = await writeMain((m) => { m.ai = validAiConfig(cfg); }, 'settings: set ai');
  return r.ai;
}

/* ================= AI 文件操作与全量 git（AI 工具用；对齐 server.js 同名函数） =================
   作用域红线：所有路径规范化后必须落在 REPO_DIR 内；.git 段与 .. 一律拒绝。
   fs_* 只落盘不提交（统一走 git_* 工具提交）；覆盖前副本存 HOME_DIR/.fs-backup/（仓外，防污染仓库）。 */
function assertRepoPath(p, opts) {
  opts = opts || {};
  if (typeof p !== 'string') throw appError(400, '路径不能为空');
  const segs = p.replace(/\\/g, '/').trim().split('/').filter((s) => s !== '' && s !== '.');
  if (p.replace(/\\/g, '/').trim().startsWith('/')) throw appError(400, '路径须为仓库相对路径');
  if (segs.some((s) => s === '..' || s.toLowerCase() === '.git' || /^[A-Za-z]:$/.test(s))) throw appError(400, '路径非法（禁止 ..、.git 与盘符）');
  if (!segs.length && !opts.allowRoot) throw appError(400, '路径不能为仓库根目录');
  const abs = path.join(REPO_DIR, ...segs);
  if (abs !== REPO_DIR && !abs.startsWith(REPO_DIR + path.sep)) throw appError(400, '路径越界');
  return { rel: segs.join('/'), abs };
}
function fsStatSafe(abs) {
  try { return fs.statSync(abs); } catch (_) { return null; }
}
function fsList(q) {
  ensureReady();
  const { rel, abs } = assertRepoPath(q || '', { allowRoot: true });
  const st = fsStatSafe(abs);
  if (rel && !st) throw appError(404, '路径不存在：' + rel);
  if (st && !st.isDirectory()) throw appError(400, '不是目录：' + rel);
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
  if (!st || !st.isFile()) throw appError(404, '文件不存在：' + rel);
  const MAX = 10 * 1024 * 1024;
  if (st.size > MAX) throw appError(400, '文件超过 10MB，AI 无法读取：' + rel);
  const buf = fs.readFileSync(abs);
  const binary = buf.subarray(0, 8192).includes(0);
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
  if (syncState.busy || writeBusy) throw appError(409, '已有写操作进行中，请稍候');
  return enqueueWrite(() => {
    const { rel, abs } = assertRepoPath(body && body.path);
    const isB64 = body && body.encoding === 'base64';
    const raw = String((body && body.content) || '');
    if (isB64 && !/^[A-Za-z0-9+/=\r\n]*$/.test(raw)) throw appError(400, 'base64 数据非法');
    const buf = isB64 ? Buffer.from(raw.replace(/\s+/g, ''), 'base64') : Buffer.from(raw, 'utf8');
    if (buf.length > 20 * 1024 * 1024) throw appError(413, '内容超过 20MB 上限');
    const st = fsStatSafe(abs);
    if (st && st.isDirectory()) throw appError(400, '同名目录已存在：' + rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const backed = backupIfExists(abs, rel.split('/').pop());
    fs.writeFileSync(abs, buf);
    return { path: rel, size: buf.length, overwrote: !!st, backup: backed };
  });
}
async function fsDelete(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw appError(409, '已有写操作进行中，请稍候');
  const paths = Array.isArray(body && body.paths) ? body.paths : (body && body.path ? [body.path] : []);
  if (!paths.length || paths.length > 50) throw appError(400, 'paths 须为 1~50 个路径');
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
    store.clearPyCache();
    return { results: out };
  });
}
async function fsMove(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw appError(409, '已有写操作进行中，请稍候');
  return enqueueWrite(() => {
    const { rel: from, abs: fromAbs } = assertRepoPath(body && body.from);
    const { rel: to, abs: toAbs } = assertRepoPath(body && body.to);
    const st = fsStatSafe(fromAbs);
    if (!st) throw appError(404, '源不存在：' + from);
    if (fsStatSafe(toAbs)) throw appError(409, '目标已存在：' + to);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    store.clearPyCache();
    return { from, to };
  });
}
async function fsMkdir(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw appError(409, '已有写操作进行中，请稍候');
  return enqueueWrite(() => {
    const { rel, abs } = assertRepoPath(body && body.path);
    if (fsStatSafe(abs)) throw appError(409, '已存在：' + rel);
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
  if (syncState.busy || writeBusy) throw appError(409, '已有写操作进行中，请稍候');
  const paths = Array.isArray(body && body.paths) ? body.paths.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (!paths.length || paths.length > 200) throw appError(400, 'paths 须为 1~200 个路径（显式清单，不做全仓 add）');
  const rels = paths.map((p) => assertRepoPath(p).rel);
  return enqueueWrite(async () => {
    await gitOk(['add', '--'].concat(rels));
    const st = await gitStatus();
    return { added: rels, stagedCount: st.entries.filter((e) => e.x !== ' ' && e.x !== '?').length };
  });
}
async function gitCommit(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw appError(409, '已有写操作进行中，请稍候');
  const msg = String((body && body.message) || '').trim();
  if (!msg || msg.length > 500) throw appError(400, '提交消息不能为空且不超过 500 字符');
  return enqueueWrite(async () => {
    await ensureAuthor();
    const staged = await git(['diff', '--cached', '--name-only']);
    if (!staged.stdout.trim()) throw appError(400, '暂存区为空：先用 git_add 暂存要提交的文件');
    await gitOk(['commit', '-m', msg]);
    const hash = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
    if (store.getConfig().remote) {
      const cnt = await gitOk(['rev-list', '--count', 'origin/' + store.MAIN_BRANCH + '..HEAD']);
      return { committed: true, hash, message: msg, unpushed: parseInt(cnt.stdout.trim() || '0', 10) };
    }
    return { committed: true, hash, message: msg, unpushed: 0 };
  });
}
async function gitPush() {
  ensureReady();
  if (!store.getConfig().remote) throw appError(409, '仅本机模式无远端可推送');
  if (syncState.busy || writeBusy) throw appError(409, '同步或写入进行中');
  return enqueueWrite(async () => {
    const r = await git(['push', 'origin', store.MAIN_BRANCH], { timeout: 300000 });
    if (r.code !== 0) throw new Error('推送失败：' + (r.stderr || r.stdout).trim().split('\n')[0]);
    syncState.ahead = 0;
    syncState.lastAt = new Date().toISOString();
    return { pushed: true };
  });
}
async function gitPull() {
  ensureReady();
  if (!store.getConfig().remote) throw appError(409, '仅本机模式无远端可拉取');
  if (syncState.busy || writeBusy) throw appError(409, '同步或写入进行中');
  return enqueueWrite(async () => {
    syncState.busy = true;
    syncState.lastError = '';
    try {
      syncState.phase = '获取远端';
      await gitOk(['fetch', 'origin'], { timeout: 300000 });
      const br = store.MAIN_BRANCH;
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
      store.clearPyCache();
    }
  });
}
async function gitDiff(q) {
  ensureReady();
  const from = String((q && q.from) || ''), to = String((q && q.to) || '');
  const hex = (s, label) => {
    if (s && !/^[0-9a-fA-F]{7,40}$/.test(s) && !/^HEAD(~\d+)?$/.test(s) && s !== 'STAGED') throw appError(400, label + ' 无效');
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
/* 分支定死 main（2026-10-27）：AI 的 git_branch 只保留 list；create/switch 已删——本地切走会让按 main 同步的流程错乱 */
async function gitBranchOp() {
  ensureReady();
  const r = await git(['branch', '--format=%(refname:short)\t%(objectname:short)\t%(HEAD)']);
  const branches = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const p = l.split('\t');
    return { name: p[0], hash: p[1] || '', current: (p[2] || '').trim() === '*' };
  });
  return { branches, remote: store.getConfig().remote || '' };
}
async function gitRestoreFiles(body) {
  ensureReady();
  if (syncState.busy || writeBusy) throw appError(409, '已有写操作进行中，请稍候');
  const commit = String((body && body.commit) || '');
  if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) throw appError(400, 'commit 无效');
  const paths = Array.isArray(body && body.paths) ? body.paths.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (!paths.length || paths.length > 200) throw appError(400, 'paths 须为 1~200 个路径');
  const rels = paths.map((p) => assertRepoPath(p).rel);
  return enqueueWrite(async () => {
    /* checkout <commit> -- paths：恢复到工作区并同时更新暂存区；是否提交由用户经 git_commit 决定 */
    const r = await git(['checkout', commit, '--'].concat(rels));
    if (r.code !== 0) throw new Error('恢复失败（该提交中可能不存在这些文件）：' + (r.stderr || '').trim().split('\n')[0]);
    store.clearPyCache();
    return { restored: rels, commit, note: '已恢复到工作区并暂存，尚未提交；确认无误后用 git_commit 提交' };
  });
}

process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && (e.stack || e.message || e));
});

module.exports = {
  git, gitOk, checkGitAvailable,
  hasRepo, stage, cloneState, syncState,
  enqueueWrite, isWriteBusy: () => writeBusy,
  setupLocal, ensureKey, rotateKey, importKey, readPrivateKey, startClone,
  bindProbe, bindConfirm, bindMerge, bindForcePush, cancelBind, unbind, forcePush,
  doSync,
  ensureReady, writePreSync, writePost, updatePost, deletePost, writeTags, setPin, writeMain,
  gitLog, gitShow, gitRestore,
  fsList, fsRead, fsWrite, fsDelete, fsMove, fsMkdir,
  gitStatus, gitAdd, gitCommit, gitPush, gitPull, gitDiff, gitBranchOp, gitRestoreFiles,
  validAiConfig, readAiSettings, setAiSettings,
};
