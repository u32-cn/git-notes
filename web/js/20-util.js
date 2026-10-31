'use strict';
/* ================= 基础设施 ================= */
function status(msg, kind) {
  var el = $('#status-bar');
  el.textContent = (kind === 'err' ? '⚠ ' : kind === 'ok' ? '✓ ' : '') + msg;
  el.className = kind || '';
}

/* Toast：一次性操作结果（自动消失）；持久/过程状态仍走 status() */
var toastTimer = null;
function toast(msg, kind) {
  var el = $('#toast');
  el.textContent = (kind === 'err' ? '⚠ ' : kind === 'ok' ? '✓ ' : '') + msg;
  el.className = kind || '';
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;   /* 重触发入场动画 */
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, kind === 'err' ? 4500 : 2400);
}
/* 写操作成功后把状态栏从「…中」恢复为就绪（结果反馈已由 toast 承担） */
function settleStatus() {
  status('就绪 · ' + state.posts.length + ' 条微笔记' + (state.timeRange ? '（时间段筛选）' : ''), 'ok');
}

function api(method, url, body) {
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, 60000);
  var headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  return fetch('/api' + url, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: ac.signal
  }).then(function (r) {
    return r.text().then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (_) { data = text; }
      if (!r.ok) {
        if (r.status === 401) { location.reload(); throw new Error('页面凭证已刷新，请重试'); }
        var e = new Error((data && data.error) || ('HTTP ' + r.status));
        e.status = r.status;
        if (data && data.conflict) e.conflict = data.conflict;
        if (data && data.needPubKey) e.needPubKey = data.needPubKey;
        throw e;
      }
      return data;
    });
  }).catch(function (e) {
    if (e.name === 'AbortError') { var t = new Error('请求超时（60s）'); t.status = 0; throw t; }
    throw e;
  }).finally(function () { clearTimeout(timer); });
}

function handleApiError(e) {
  toast('错误：' + e.message, 'err');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function postTimeFull(p) {
  var s = p.created || (p.stem || '');
  var m = /^(\d{4})(\d{2})(\d{2})[- ]?(\d{2})(\d{2})/.exec(s);
  return m ? (m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : (s || '');
}
/* 相对时间：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / M月D日 / YYYY年M月D日（完整时间在 title） */
function postTime(p) {
  var m = /^(\d{4})(\d{2})(\d{2})[- ]?(\d{2})(\d{2})/.exec(p.created || p.stem || '');
  if (!m) return p.created || p.stem || '';
  var y = +m[1], mo = +m[2], d = +m[3], hm = m[4] + ':' + m[5];
  var now = new Date();
  var diff = now - new Date(y, mo - 1, d, +m[4], +m[5]);
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  var days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, mo - 1, d)) / 86400e3);
  if (days === 0) return '今天 ' + hm;
  if (days === 1) return '昨天 ' + hm;
  if (y === now.getFullYear()) return mo + '月' + d + '日';
  return y + '年' + mo + '月' + d + '日';
}
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* 纯文本展示：转义 + 保留换行 + http(s) 链接可点击。
   外链走 gn-external:// 前缀：三端各自拦截分发（安卓 shouldOverrideUrlLoading / electron
   will-navigate 交系统浏览器；web 浏览器版由 90-events.js 点击代理 window.open 新标签） */
function textHtml(s) {
  return esc(s).replace(/(https?:\/\/[^\s]+)/g, function (_, u) {
    var trail = '';
    while (u && /[.,;:!?、。！？…）)]$/.test(u.charAt(u.length - 1))) { trail = u.charAt(u.length - 1) + trail; u = u.slice(0, -1); }
    return '<a href="gn-external://' + u + '">' + u + '</a>' + trail;
  });
}
function mediaUrl(dir, name) { return '/media/' + encodeURIComponent(dir + '/' + name); }

/* ================= 本地 API 封装 ================= */
function apiStatus() { return api('GET', '/status'); }
function apiSetupKey() { return api('POST', '/setup/key', {}); }
function apiRotateKey() { return api('POST', '/setup/key/rotate', {}); }
function apiImportKey(privateKey) { return api('POST', '/setup/key/import', { privateKey: privateKey }); }
function apiPrivateKey() { return api('POST', '/setup/key/private', {}); }
function apiSetupLocal() { return api('POST', '/setup/local', {}); }
function apiSetupClone(remote) { return api('POST', '/setup/clone', { remote: remote }); }
function apiSync() { return api('POST', '/sync', {}); }
function apiBindConnect(remote) { return api('POST', '/bind/connect', { remote: remote }); }
function apiUnbind() { return api('POST', '/unbind', {}); }
function apiForcePush() { return api('POST', '/force-push', {}); }
function apiRemoteOverwrite() { return api('POST', '/remote-overwrite', {}); }
function apiPosts(before) { return api('GET', '/posts' + (before ? '?before=' + encodeURIComponent(before) : '')); }
function apiCreatePost(payload) { return api('POST', '/posts', payload); }
function apiUpdatePost(payload) { return api('PUT', '/posts', payload); }
function apiDeletePost(path) { return api('DELETE', '/posts', { path: path }); }
function apiPin(path, pinned) { return api('POST', '/posts/pin', { path: path, pinned: pinned }); }
function apiGetTags() { return api('GET', '/tags'); }
function apiSaveTags(tags, action, tag) { return api('PUT', '/tags', { tags: tags, action: action, tag: tag }); }
function apiSearch(q) { return api('GET', '/search?q=' + encodeURIComponent(q)); }
function applySyncInfo(s) {
  syncInfo.ahead = s.ahead; syncInfo.behind = s.behind; syncInfo.lastAt = s.lastAt;
  syncInfo.lastError = s.lastError; syncInfo.conflict = s.conflict || null;
}
function refreshSyncStatus() {
  return apiStatus().then(function (st) {
    state.stage = st.stage;
    state.remote = st.remote || '';
    state.branch = st.branch || '';
    state.hasKey = !!(st.key && st.key.exists);
    applySyncInfo(st.sync);
    renderSyncInfo();
  }).catch(function () {});
}
function fmtTime(iso) {
  if (!iso) return '从未';
  var d = new Date(iso);
  return '' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ================= 杂项工具 ================= */
function filesFromClipboard(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return [];
  var files = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
      var f = items[i].getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}
/* 发布器输入框随内容长高，封顶 240px 后出滚动条（overflow-y:auto） */
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}

/* ================= 主题（浅/深/跟随系统；html[data-theme] 单点应用，CSS 变量双套） ================= */
var THEME_KEY = 'gnTheme';
var themeMq = window.matchMedia('(prefers-color-scheme: dark)');
function themePref() {
  try { var v = localStorage.getItem(THEME_KEY); return (v === 'light' || v === 'dark') ? v : 'auto'; } catch (_) { return 'auto'; }
}
function applyTheme() {
  var p = themePref();
  var dark = p === 'dark' || (p === 'auto' && themeMq.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
themeMq.addEventListener('change', function () { if (themePref() === 'auto') applyTheme(); });
function setThemePref(p) {
  try { localStorage.setItem(THEME_KEY, p); } catch (_) {}
  applyTheme();
  if (typeof renderThemeOpts === 'function') renderThemeOpts();
}

/* ================= 字号（帖子正文/发布/编辑输入框；滑动条 10–50px，默认 14，仅本机 localStorage） ================= */
var FONT_SIZE_KEY = 'gnFontSize';
var FONT_SIZE_DEFAULT = 14;
var FONT_SIZE_MIN = 10, FONT_SIZE_MAX = 50;
function fontSizePref() {
  try {
    var v = Math.round(Number(localStorage.getItem(FONT_SIZE_KEY)));
    return (v >= FONT_SIZE_MIN && v <= FONT_SIZE_MAX) ? v : FONT_SIZE_DEFAULT;
  } catch (_) { return FONT_SIZE_DEFAULT; }
}
function applyFontSize() {
  document.documentElement.style.setProperty('--fs-post', fontSizePref() + 'px');
}
function setFontSizePref(n) {
  try { localStorage.setItem(FONT_SIZE_KEY, String(n)); } catch (_) {}
  applyFontSize();
  if (typeof renderFontOpts === 'function') renderFontOpts();
}

/* ================= 视图路由（feed / ai / set 三页；≥1024px 时 feed+ai 恒双栏） ================= */
var wideMq = window.matchMedia('(min-width: 1024px)');
var curView = 'feed';
function showView(name) {
  curView = name;
  var dual = wideMq.matches && (name === 'feed' || name === 'ai');
  $('#shell').classList.toggle('dual', dual);
  $('#view-feed').classList.toggle('on', dual || name === 'feed');
  $('#view-ai').classList.toggle('on', dual || name === 'ai');
  $('#view-set').classList.toggle('on', name === 'set');
  $('#view-help').classList.toggle('on', name === 'help');
  $('#btn-nav-feed').classList.toggle('on', name === 'feed');
  $('#btn-nav-ai').classList.toggle('on', name === 'ai');
  $('#btn-nav-set').classList.toggle('on', name === 'set');
  $('#btn-help').classList.toggle('on', name === 'help');
  if (name === 'set') renderSettingsPage();
  if (name === 'help' && typeof loadHelpView === 'function') loadHelpView();
  if (name === 'ai') {
    aiLoadConf();   /* 打开 AI 页时刷新配置（其他设备可能已改） */
    var box = $('#ai-msgs');
    box.scrollTop = box.scrollHeight;
  }
  if (name === 'feed' && state.ready) chainMore();
}
wideMq.addEventListener('change', function () { showView(curView); });
applyTheme();
applyFontSize();

/* ================= 日期分隔（倒排信息流按相邻帖日期插胶囊） ================= */
function daySepLabel(day) {   /* day=YYYYMMDD */
  if (!/^\d{8}$/.test(day)) return '';
  var y = +day.slice(0, 4), mo = +day.slice(4, 6), d = +day.slice(6, 8);
  var now = new Date();
  var n = Number(day);
  var today = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  var yd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var ynum = yd.getFullYear() * 10000 + (yd.getMonth() + 1) * 100 + yd.getDate();
  var md = mo + '月' + d + '日';
  if (n === today) return '今天 · ' + md;
  if (n === ynum) return '昨天 · ' + md;
  if (y === now.getFullYear()) return md;
  return y + '年' + md;
}
