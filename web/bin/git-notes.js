#!/usr/bin/env node
'use strict';
/* git-notes —— Git笔记 命令行
 *
 * git-notes            确保服务在跑（没跑则后台拉起），然后打开笔记页面
 * git-notes status     查看运行状态 / PID / 版本
 * git-notes stop       停止后台服务
 * git-notes -v         显示版本
 * git-notes help       帮助
 *
 * 笔记操作子命令（转发到本机服务的 /api，业务逻辑单一事实源在 server.js）：
 * git-notes list [--limit N] [--tag 标签] [--json]      列出笔记（新→旧）
 * git-notes add "<正文>" [--tag a,b] [--json]           新增笔记
 * git-notes edit <id> "<正文>" [--tag a,b] [--json]     编辑笔记（不改标签时保留原标签）
 * git-notes rm <id> [--yes]                             删除笔记
 * git-notes pin <id> [--off]                            钉住 / 取消钉住
 * git-notes show <id>                                   查看笔记原文（Markdown）
 * git-notes search "<关键词>" [--json]                  全库搜索（支持拼音/首字母）
 * git-notes tags                                        列出全部标签
 * git-notes sync                                        手动同步（绑定了远端时）
 * git-notes log [--limit N] [--path <笔记路径>]         查看提交历史
 * git-notes doctor [目录]                               校验笔记文件合规性（只读本地检查）
 *
 * id 为笔记路径（list/search 输出的 path 字段，如 micro/2026/11/20261105-123456.md）或裸文件名。
 * CLI 发起的写操作会在提交信息里带 [ai] 标记。
 *
 * 环境变量：GN_PORT（默认 8644）、GN_NO_OPEN=1（不自动开浏览器，脚本/测试用）、GN_HOME（覆盖数据目录，测试/多实例隔离用）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(PKG_ROOT, 'package.json')).version;
const PORT = Number(process.env.GN_PORT) || 8644;
const BASE = `http://127.0.0.1:${PORT}`;
/* 数据目录：默认 ~/.git-notes，GN_HOME 可覆盖（测试/多实例隔离用），与 server.js 一致 */
const DATA_DIR = process.env.GN_HOME ? path.resolve(process.env.GN_HOME) : path.join(os.homedir(), '.git-notes');
const REPO_DIR = path.join(DATA_DIR, 'repo');
const TOKEN_FILE = path.join(DATA_DIR, 'git-notes.token');
const PID_FILE = path.join(DATA_DIR, 'git-notes.pid');
const LOG_FILE = path.join(DATA_DIR, 'git-notes.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 探测 8644：down=没服务；ours=本服务（带版本/PID）；foreign=端口被其他程序占用 */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/healthz', { timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let info = null;
        try { info = JSON.parse(body); } catch (_) {}
        if (res.statusCode === 200 && info && info.ok) {
          resolve({ kind: 'ours', version: info.version, pid: info.pid });
        } else {
          resolve({ kind: 'foreign' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ kind: 'foreign' }); });
    req.on('error', (e) => {
      resolve(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? { kind: 'down' } : { kind: 'foreign' });
    });
  });
}

function staleCheck(info) {
  if (info.version && info.version !== VERSION) {
    console.warn(`[warn] 运行中的服务是旧版本 v${info.version}（CLI 为 v${VERSION}）。执行 git-notes stop 后再执行 git-notes 可更新。`);
  }
}

function openBrowser(url) {
  if (process.env.GN_NO_OPEN === '1') return;
  try {
    /* 无桌面环境（无 xdg-open 等）时 spawn ENOENT 会触发 error 事件，静默吞掉避免崩 CLI */
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch (_) {
    /* 打不开不影响服务 */
  }
}

async function startService() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(PKG_ROOT, 'server.js')], {
    cwd: PKG_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  fs.closeSync(out);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const p = await probe();
    if (p.kind === 'ours') return p;
    if (p.kind === 'foreign') throw new Error(`端口 ${PORT} 被其他程序占用，可用 GN_PORT=<端口> 换端口`);
  }
  throw new Error('服务启动超时（可能缺少 git），请查看日志 ' + LOG_FILE);
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch (_) { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

/* Windows 上 detached 的 node 收不到 SIGTERM，kill 无效时用 taskkill 强杀 */
function forceKill(pid) {
  try { process.kill(pid); } catch (_) {}
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' }); } catch (_) {}
  }
}

async function cmdDefault() {
  const p = await probe();
  if (p.kind === 'ours') {
    staleCheck(p);
    console.log('服务已在运行：' + BASE);
  } else if (p.kind === 'down') {
    console.log('启动 git-notes 服务…');
    const info = await startService();
    staleCheck(info);
    console.log('服务已启动：' + BASE);
  } else {
    console.error(`[error] 端口 ${PORT} 已被其他程序占用。可用 GN_PORT=<端口> 换端口后重试。`);
    process.exit(1);
  }
  openBrowser(BASE);
}

async function cmdStatus() {
  const p = await probe();
  if (p.kind === 'ours') {
    console.log(`运行中：${BASE}`);
    if (p.version !== VERSION) {
      console.log(`  版本 v${p.version}（CLI 为 v${VERSION}，建议 git-notes stop 后再启动以更新）`);
    } else {
      console.log(`  版本 v${p.version}`);
    }
    if (p.pid) console.log(`  PID ${p.pid}`);
    console.log(`  日志 ${LOG_FILE}`);
  } else if (p.kind === 'down') {
    console.log('未在运行。');
    const pf = readPidFile();
    if (pf && pidAlive(pf.pid)) console.log(`[warn] 发现残留 pid 记录（${pf.pid}），可执行 git-notes stop 清理。`);
  } else {
    console.log(`端口 ${PORT} 被其他程序占用（非本服务）。`);
  }
}

async function cmdStop() {
  const pf = readPidFile();
  if (pf && pidAlive(pf.pid)) {
    forceKill(pf.pid);
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if ((await probe()).kind === 'down') break;
    }
    const cur = readPidFile();
    if (cur && cur.pid === pf.pid) { try { fs.unlinkSync(PID_FILE); } catch (_) {} }
    console.log('服务已停止（PID ' + pf.pid + '）。');
  } else {
    if (pf) { try { fs.unlinkSync(PID_FILE); } catch (_) {} }
    const p = await probe();
    if (p.kind === 'ours') console.log('服务在运行但无 pid 记录（非本工具托管），请在其终端 Ctrl+C 停止。');
    else if (p.kind === 'down') console.log('服务未在运行。');
    else console.log(`端口 ${PORT} 被其他程序占用，非本服务，未做处理。`);
  }
}

/* ================= 笔记操作子命令（转发本机服务 /api） ================= */

function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

async function api(method, urlPath, body) {
  const token = readToken();
  const headers = {};
  if (token) headers.Cookie = 'gn_token=' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = (data && data.error) || ('HTTP ' + res.status);
    if (res.status === 401) throw new Error('CLI 凭证无效（可能服务被重启过且 token 未更新），执行 git-notes stop 后重试');
    if (res.status === 409 && /首次配置/.test(msg)) throw new Error('笔记库尚未初始化，先执行 git-notes 打开页面完成首次配置');
    throw new Error(msg);
  }
  return data;
}

/* 确保/拉起本机服务（不开浏览器），返回 probe 结果 */
async function ensureService() {
  const p = await probe();
  if (p.kind === 'ours') { staleCheck(p); return p; }
  if (p.kind === 'down') return startService();
  throw new Error(`端口 ${PORT} 被其他程序占用，可用 GN_PORT=<端口> 换端口`);
}

/* 参数解析：位置参数 + --key value / --flag 布尔 */
function parseArgs(rest) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opt.json = true;
    else if (a === '--yes') opt.yes = true;
    else if (a === '--off') opt.off = true;
    else if (a === '--limit') opt.limit = Number(rest[++i]) || undefined;
    else if (a === '--tag') opt.tag = String(rest[++i] || '');
    else if (a === '--path') opt.path = String(rest[++i] || '');
    else pos.push(a);
  }
  return { pos, opt };
}

function fmtTags(tags) { return (tags && tags.length) ? ' [' + tags.join(', ') + ']' : ''; }
function fmtPost(p) {
  return p.path + fmtTags(p.tags) + '\n    ' + String(p.text || '').replace(/\s+/g, ' ').slice(0, 120);
}

/* 按 API 分页把笔记全部拉平（新→旧），直到取够 limit 或没有更多 */
async function fetchAllPosts(limit) {
  const out = [];
  let before = '';
  for (;;) {
    const page = await api('GET', '/api/posts' + (before ? '?before=' + before : ''));
    out.push(...page.posts);
    if (page.pins && page.pins.length) out.push(...page.pins);
    if (!page.more || (limit && out.length >= limit)) break;
    before = page.month;   /* 当前页月份更早一页 */
    if (!before) break;
  }
  /* pins 与普通帖可能重复、跨月页 pins 重复，按 path 去重 */
  const seen = new Set();
  return out.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)))
    .sort((a, b) => b.stem.localeCompare(a.stem))
    .slice(0, limit || out.length);
}

/* id → 笔记路径：接受完整 path 或裸文件名（带不带 .md 均可） */
async function resolveId(id) {
  const arg = String(id || '');
  if (/^micro\/\d{4}\/\d{2}\/[A-Za-z0-9._-]+\.md$/.test(arg)) return arg;
  const stem = arg.replace(/\.md$/, '');
  const posts = await fetchAllPosts(0);
  const hit = posts.find((p) => p.stem === stem || p.name === stem + '.md');
  if (hit) return hit.path;
  throw new Error('找不到笔记：' + arg + '（id 用 list/search 输出的 path 字段）');
}

function splitTags(optTag) {
  if (optTag === undefined) return undefined;   /* 未指定：保留原标签 */
  return optTag ? optTag.split(/[,，\s]+/).filter(Boolean) : [];
}

function printJson(v) { console.log(JSON.stringify(v, null, 2)); }

async function cmdList(rest) {
  const { opt } = parseArgs(rest);
  const posts = await fetchAllPosts(opt.limit || 20);
  const filtered = opt.tag !== undefined ? posts.filter((p) => p.tags.indexOf(opt.tag) > -1) : posts;
  if (opt.json) return printJson(filtered);
  if (!filtered.length) return console.log('（没有笔记' + (opt.tag !== undefined ? '，tag=' + opt.tag : '') + '）');
  console.log(filtered.map(fmtPost).join('\n'));
}

async function cmdAdd(rest) {
  const { pos, opt } = parseArgs(rest);
  const text = pos.join(' ');
  if (!text) throw new Error('用法：git-notes add "<正文>" [--tag a,b]');
  const out = await api('POST', '/api/posts', { text, tags: splitTags(opt.tag) || [], ai: true });
  if (opt.json) return printJson(out);
  console.log('已添加：' + out.path);
}

async function cmdEdit(rest) {
  const { pos, opt } = parseArgs(rest);
  const rel = await resolveId(pos.shift());
  const text = pos.join(' ');
  if (!text) throw new Error('用法：git-notes edit <id> "<新正文>" [--tag a,b]');
  const cur = (await fetchAllPosts(0)).find((p) => p.path === rel);
  if (!cur) throw new Error('笔记当前不可见：' + rel);
  const out = await api('PUT', '/api/posts', { path: rel, text, tags: splitTags(opt.tag) !== undefined ? splitTags(opt.tag) : cur.tags, ai: true });
  if (opt.json) return printJson(out);
  console.log('已更新：' + out.path);
}

async function cmdRm(rest) {
  const { pos, opt } = parseArgs(rest);
  const rel = await resolveId(pos[0]);
  if (!opt.yes) {
    console.log('将删除：' + rel + '（加 --yes 跳过确认）');
    if (process.stdin.isTTY) {
      process.stdout.write('确认删除？[y/N] ');
      const ok = await new Promise((resolve) => {
        process.stdin.once('data', (d) => resolve(/^y/i.test(String(d).trim())));
      });
      if (!ok) return console.log('已取消。');
    } else {
      return console.log('已取消（非交互环境需加 --yes）。');
    }
  }
  await api('DELETE', '/api/posts', { path: rel, ai: true });
  console.log('已删除：' + rel);
}

async function cmdPin(rest) {
  const { pos, opt } = parseArgs(rest);
  const rel = await resolveId(pos[0]);
  const pins = await api('POST', '/api/posts/pin', { path: rel, pinned: !opt.off, ai: true });
  console.log((opt.off ? '已取消钉住：' : '已钉住：') + rel);
  if (Array.isArray(pins)) console.log('当前钉住 ' + pins.length + ' 篇');
}

async function cmdShow(rest) {
  const rel = await resolveId(parseArgs(rest).pos[0]);
  const f = await api('GET', '/api/fs/read?path=' + encodeURIComponent(rel));
  if (f.encoding !== 'text') throw new Error('不是文本文件：' + rel);
  console.log(f.content);
}

async function cmdSearch(rest) {
  const { pos, opt } = parseArgs(rest);
  const q = pos.join(' ');
  if (!q) throw new Error('用法：git-notes search "<关键词>"');
  const out = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  if (opt.json) return printJson(out);
  if (!out.hits.length) return console.log('（无命中）');
  console.log(out.hits.map(fmtPost).join('\n'));
  console.log(`共 ${out.hits.length} 条命中（全库 ${out.total} 篇，${out.ms}ms）`);
}

async function cmdTags(rest) {
  if (parseArgs(rest).opt.json) return printJson((await api('GET', '/api/tags')).tags);
  const tags = (await api('GET', '/api/tags')).tags;
  console.log(tags.length ? tags.join('\n') : '（无标签）');
}

async function cmdSync() {
  const out = await api('POST', '/api/sync');
  console.log(out.local ? '仅本机模式（未绑定远端），无需同步。' : '同步完成：' + JSON.stringify(out));
}

async function cmdLog(rest) {
  const { opt } = parseArgs(rest);
  const qs = new URLSearchParams();
  if (opt.limit) qs.set('limit', String(opt.limit));
  if (opt.path) qs.set('path', await resolveId(opt.path));
  const out = await api('GET', '/api/git/log' + (qs.toString() ? '?' + qs : ''));
  if (opt.json) return printJson(out);
  console.log(out.commits.map((c) => c.hash.slice(0, 8) + ' ' + c.date + ' ' + c.subject).join('\n') || '（无提交）');
}

/* ---- doctor：纯本地文件合规检查（不经过服务，只读） ---- */

function checkPostFile(abs, rel, issues) {
  const stem = path.basename(rel, '.md');
  const dir = path.dirname(rel);
  const dirM = /^micro[\\/](\d{4})[\\/](\d{2})$/.exec(dir);
  if (!dirM) { issues.push(rel + '：目录不符合 micro/YYYY/MM/'); return null; }
  const stemM = /^(\d{8})-(\d{6})(?:-([A-Za-z0-9._-]+))?$/.exec(stem);
  if (!stemM) { issues.push(rel + '：文件名不符合 YYYYMMDD-HHMMSS[-主题名].md'); return null; }
  if (stemM[1].slice(0, 4) !== dirM[1] || stemM[1].slice(4, 6) !== dirM[2]) {
    issues.push(rel + '：文件名日期与所在目录 ' + dir.replace(/\\/g, '/') + ' 不一致');
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fm) { issues.push(rel + '：缺少 front matter（--- 块）'); return null; }
  const head = fm[1];
  if (!/^type: micro$/m.test(head)) issues.push(rel + '：front matter 缺 type: micro');
  const cm = head.match(/^created:\s*"?(\d{8}) (\d{6})"?$/m);
  if (!cm) issues.push(rel + '：front matter 缺 created 或格式应为 "YYYYMMDD HHMMSS"');
  else if (cm[1] !== stemM[1] || cm[2] !== stemM[2]) issues.push(rel + '：created 与文件名时间戳不一致');
  const tm = head.match(/^tags:\s*(\[.*\])$/m);
  let media = [];
  if (tm) { try { JSON.parse(tm[1]); } catch (_) { issues.push(rel + '：tags 不是合法 JSON 数组'); } }
  const listRe = /^(\w+):\s*$/gm;
  let lm;
  while ((lm = listRe.exec(head))) {
    const key = lm[1];
    const rest = head.slice(lm.index + lm[0].length).split(/\r?\n/).slice(1);
    for (const line of rest) {
      const im = line.match(/^\s+-\s*(.+)$/);
      if (!im) break;
      if (key === 'images' || key === 'files') {
        const disk = String(im[1]).includes('|') ? String(im[1]).split('|')[1] : String(im[1]);
        media.push(disk);
        if (!fs.existsSync(path.join(path.dirname(abs), disk))) issues.push(rel + '：引用的 ' + key + ' 文件不存在：' + disk);
      }
    }
  }
  /* 同目录下属于本条时间戳但未被引用的媒体文件（排除其他条目的 -N/-fN 序号歧义：按精确前缀匹配） */
  return { stem, media };
}

async function cmdDoctor(rest) {
  const root = parseArgs(rest).pos[0] ? path.resolve(parseArgs(rest).pos[0]) : REPO_DIR;
  if (!fs.existsSync(path.join(root, 'micro'))) {
    throw new Error('未找到 micro/ 目录：' + root + '（默认检查 ' + REPO_DIR + '）');
  }
  const issues = [];
  const refs = {};   /* 媒体文件 → 引用它的笔记 stem */
  const seen = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile() || !/\.md$/.test(e.name)) continue;
      const rel = path.relative(root, abs);
      if (seen.has(rel)) continue;
      seen.add(rel);
      const info = checkPostFile(abs, rel, issues);
      if (info) for (const m of info.media) (refs[m] = refs[m] || []).push(path.basename(rel, '.md'));
    }
  };
  walk(path.join(root, 'micro'));
  /* 孤儿媒体：micro 下非 .md 文件，文件名前缀（去 -N/-fN 序号）不对应任何笔记的引用 */
  const orphanWalk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { orphanWalk(abs); continue; }
      if (!e.isFile() || /\.md$/.test(e.name)) continue;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      const name = e.name.replace(/\.[A-Za-z0-9]+$/, '').replace(/-(f)?\d+$/, '');
      if (!refs[e.name] && !refs[name]) issues.push(rel + '：孤儿媒体文件（无笔记引用）');
    }
  };
  orphanWalk(path.join(root, 'micro'));
  if (issues.length) {
    console.log('发现问题 ' + issues.length + ' 处：');
    console.log(issues.map((s) => '  - ' + s.replace(/\\/g, '/')).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('检查通过：' + seen.size + ' 篇笔记全部合规（目录/文件名/front matter/媒体引用）。');
  }
}

const SUBCOMMANDS = {
  list: cmdList, add: cmdAdd, edit: cmdEdit, rm: cmdRm, delete: cmdRm,
  pin: cmdPin, show: cmdShow, search: cmdSearch, tags: cmdTags,
  sync: cmdSync, log: cmdLog, doctor: cmdDoctor,
};

const arg = process.argv[2];
const rest = process.argv.slice(3);
(async () => {
  if (arg === 'status') return cmdStatus();
  if (arg === 'stop') return cmdStop();
  if (arg === '-v' || arg === '--version') return console.log('git-notes v' + VERSION);
  if (arg === 'help' || arg === '-h' || arg === '--help') {
    console.log([
      'git-notes —— Git笔记：本地 git 仓库架构的微笔记',
      '  git-notes            启动（如未运行）并打开笔记页面',
      '  git-notes status     查看运行状态',
      '  git-notes stop       停止后台服务',
      '',
      '笔记操作（供人/AI 工具使用，写操作提交信息带 [ai] 标记）：',
      '  git-notes list [--limit N] [--tag 标签] [--json]   列出笔记（新→旧）',
      '  git-notes add "<正文>" [--tag a,b] [--json]        新增笔记',
      '  git-notes edit <id> "<新正文>" [--tag a,b]         编辑（不指定 --tag 保留原标签）',
      '  git-notes rm <id> [--yes]                          删除笔记',
      '  git-notes pin <id> [--off]                         钉住 / 取消钉住',
      '  git-notes show <id>                                查看笔记原文',
      '  git-notes search "<关键词>" [--json]               全库搜索（支持拼音/首字母）',
      '  git-notes tags                                     列出全部标签',
      '  git-notes sync                                     手动同步（绑定远端时）',
      '  git-notes log [--limit N] [--path <笔记路径>]      查看提交历史',
      '  git-notes doctor [目录]                            校验笔记文件合规性（只读）',
      '',
      '  id = 笔记路径（list/search 输出的 path，如 micro/2026/11/20261105-123456.md）或裸文件名',
      '  --json 输出原始 JSON（供程序/AI 解析）',
      '',
      `数据目录：${DATA_DIR}（本地仓库、SSH 密钥、pid 与日志）`,
      '两种模式：仅本机使用（无需任何远端）；绑定任意远端 git 服务器后自动同步。',
    ].join('\n'));
    return;
  }
  if (arg === undefined) return cmdDefault();
  if (SUBCOMMANDS[arg]) {
    await ensureService();
    return SUBCOMMANDS[arg](rest);
  }
  console.error('未知命令：' + arg + '（git-notes help 查看用法）');
  process.exit(1);
})().catch((e) => {
  console.error('[error] ' + e.message);
  process.exit(1);
});
