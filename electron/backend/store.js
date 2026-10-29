// 数据层：~/.git-notes 路径、远端绑定状态、micro/ 规范格式、标签、按月列举与全库搜索。
// 语义对齐 web/server.js（改动 server.js 对应行为时需手工同步本文件，义务见 AGENTS.md）。

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = path.join(os.homedir(), '.git-notes');
const KEY_DIR = path.join(HOME_DIR, 'keys');
const KEY_FILE = path.join(KEY_DIR, 'id_ed25519');
const PUB_FILE = KEY_FILE + '.pub';
const KNOWN_HOSTS = path.join(KEY_DIR, 'known_hosts');
const REPO_DIR = path.join(HOME_DIR, 'repo');

const DEFAULT_TAGS = ['待办', '已完成待办', '备忘', '日记', '杂记', '收藏', '想法', '感悟'];
const MAX_IMAGES = 9;
const MAX_FILES = 9;
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };
/* 非图片附件的 Content-Type 猜测表；不在表内一律 octet-stream，且 /media 直出统一 attachment 下载，防同源 html/svg 执行 */
const FILE_MIME = { pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', gz: 'application/gzip', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

/* ================= 配置（远端绑定的唯一事实源：repo/.git/config 的 origin） =================
   同一配置信息只存一份：git 层的 origin 由 git 命令（clone / remote add|remove）落盘，
   应用启动时解析一次入内存，此后绑定/解绑只改内存（磁盘已由对应 git 命令写好）。
   不再有 config.json——避免两处存储不一致导致的状态错乱（2026-10-28，对齐 server.js）。 */
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

/* ================= 校验（写路径白名单与输入约束） ================= */

function appError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
function assertPostPath(p) {
  if (typeof p !== 'string' || !/^micro\/\d{4}\/\d{2}\/[A-Za-z0-9._-]+\.md$/.test(p)) {
    throw appError(400, '非法的笔记路径');
  }
  const abs = path.join(REPO_DIR, p);
  if (!abs.startsWith(path.join(REPO_DIR, 'micro') + path.sep)) throw appError(400, '非法的笔记路径');
  return abs;
}
function validTags(tags) {
  if (!Array.isArray(tags) || tags.length > 20) throw appError(400, '标签数量超限');
  return tags.map((t) => String(t).trim().replace(/[\[\]",{}]/g, '').replace(/\s+/g, ' ').slice(0, 16)).filter(Boolean);
}
function validImages(imgs) {
  if (imgs === undefined || imgs === null) return [];
  if (!Array.isArray(imgs) || imgs.length > MAX_IMAGES) throw appError(400, '最多 ' + MAX_IMAGES + ' 张图');
  return imgs.map((im) => {
    const ext = String(im.ext || '').toLowerCase();
    const b64 = String(im.base64 || '');
    if (!IMG_MIME[ext]) throw appError(400, '仅支持图片（png/jpg/webp/gif/bmp/avif）');
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64) || b64.length > 14 * 1024 * 1024) throw appError(400, '图片数据非法或超过 10MB');
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
  if (!Array.isArray(files) || files.length > MAX_FILES) throw appError(400, '最多 ' + MAX_FILES + ' 个附件');
  return files.map((f) => {
    const name = sanitizeFileName(f && f.name);
    const ext = String((f && f.ext) || '').toLowerCase();
    if (!/^[a-z0-9]{1,12}$/.test(ext)) throw appError(400, '附件扩展名非法');
    const b64 = String((f && f.base64) || '');
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64) || b64.length > 14 * 1024 * 1024) throw appError(400, '附件数据非法或超过 10MB');
    return { name, ext, buf: Buffer.from(b64.replace(/\s+/g, ''), 'base64') };
  });
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
    if (!/^\d{6}$/.test(before)) throw appError(400, 'before 须为 YYYYMM');
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
/* ================= 拼音索引（全库搜索支持拼音/首字母，对齐 web/server.js pyIndexOf） =================
   每帖缓存 {full: 全拼串, initials: 首字母串}：汉字转音节、其余字符原样保留；
   写操作与同步后 clearPyCache()（内容可能已变）。 */
const { buildCharPinyin } = require('./pinyin-data');
const charPinyin = buildCharPinyin();
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
/* ================= 仓库统一设置 settings/main.json（version:1，收编原 tags.json/ai.json；对齐 server.js） =================
   读不到就创建；旧 settings/tags.json 与 settings/ai.json 在首次读取时一次性收编进 main.json
   （只迁数据不提交，提交随下一次设置写操作落地），此后只认 main.json，version!==1 拒读走默认。 */
const MAIN_JSON = 'settings/main.json';
const MAX_PINS = 9;
/* AI 配置规范化：key 明文入仓是用户知情的选择（多端免配置），远端仓库须可信；只做规范化，不落日志。 */
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
    try { o = JSON.parse(raw); } catch (_) { throw appError(500, 'main.json 解析失败'); }
    if (!o || typeof o !== 'object' || o.version !== 1) throw appError(500, 'main.json version 非法');
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
function readTags() {
  return readMain().tags;
}

module.exports = {
  HOME_DIR, KEY_DIR, KEY_FILE, PUB_FILE, KNOWN_HOSTS, REPO_DIR,
  DEFAULT_TAGS, MAX_IMAGES, MAX_FILES, MAX_PINS, IMG_MIME, FILE_MIME, MAIN_JSON,
  saveConfig, getConfig: () => config, MAIN_BRANCH, isSshRemote,
  pad2, tsOf, createdStr, summarize, buildMicroMd, parsePost, readPost,
  appError, assertPostPath, validTags, validImages, sanitizeFileName, validFiles,
  listMonths, monthHasPosts, listPosts, pagePosts, searchAll, readTags, clearPyCache,
  validAiConfig, defaultMain, writeMainRaw, normalizeMain, readMain,
};
