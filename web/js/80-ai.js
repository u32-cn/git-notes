'use strict';
/* ================= AI 助手（80-ai.js）
   架构：前端直连 OpenAI 兼容 /chat/completions（SSE 流式，fetch reader 手写解析），
   工具调用循环 ≤12 轮；九工具三组（筛选检索只读 / 笔记写入批量 / git 历史追加式），
   权限三级（只读/确认/自动）；白名单 Markdown 渲染（模型内容永不走 innerHTML）；
   会话 localStorage 持久（工具载荷不入库）。详见 docs/ai-plan.md。 ================= */

/* ================= 配置（存笔记仓库 settings/ai.json，随 git 同步多端共享；本文件是内存缓存）
   key 明文入仓是用户知情的选择；旧 localStorage 配置在首次加载时一次性迁入仓库 ================= */
var aiConf = { baseURL: '', apiKey: '', model: '', extra: null };
var aiConfOnce = false;   /* 首次成功拉取后做面板默认态与旧配置迁移 */
function aiCfg() { return aiConf; }
function aiNormalize(c) {
  c = c && typeof c === 'object' ? c : {};
  return {
    baseURL: String(c.baseURL || '').trim().replace(/\/+$/, ''),
    apiKey: String(c.apiKey || ''),
    model: String(c.model || '').trim(),
    extra: (c.extra && typeof c.extra === 'object' && !Array.isArray(c.extra)) ? c.extra : null
  };
}
function aiConfigured() { return !!(aiConf.baseURL && aiConf.model); }
/* 权限模式只存本机 localStorage（各设备各自记忆，不入仓不随 git 同步），默认 confirm */
var AI_MODE_KEY = 'gnAiMode';
function aiMode() {
  try {
    var v = localStorage.getItem(AI_MODE_KEY);
    return (v === 'ro' || v === 'auto') ? v : 'confirm';
  } catch (_) { return 'confirm'; }
}
function aiSetMode(m) { try { localStorage.setItem(AI_MODE_KEY, m); } catch (_) {} }
function aiLoadConf() {
  return api('GET', '/ai/settings').then(function (c) {
    aiConf = aiNormalize(c);
    if (!aiConfOnce) {
      aiConfOnce = true;
      aiMigrateLocalConf();
    }
    aiRenderModePills();
    aiRenderUnconfig();
  }).catch(function () {});
}
function aiSaveConf(c) {
  return api('POST', '/ai/settings', c).then(function (saved) {
    aiConf = aiNormalize(saved);
    aiRenderModePills();
    aiRenderUnconfig();
    return aiConf;
  });
}
var AI_MODE_LABEL = { ro: '只读模式', confirm: '确认模式', auto: '自动模式' };
function aiMigrateLocalConf() {   /* v1 配置在 localStorage：仓库里还没有时一次性搬入 */
  var old = null;
  try { old = JSON.parse(localStorage.getItem('gnAiConfig') || 'null'); } catch (_) {}
  if (!old || !old.baseURL || !old.model || aiConfigured()) return;
  aiSaveConf(aiNormalize(old)).then(function () {
    localStorage.removeItem('gnAiConfig');
    toast('已把旧 AI 配置迁入笔记仓库（多端共享）', 'ok');
  }).catch(function () {});
}

function aiSettingsLoad() {
  $('#ai-base').value = aiConf.baseURL;
  $('#ai-key').value = aiConf.apiKey;
  $('#ai-model').value = aiConf.model;
  $('#ai-extra').value = aiConf.extra ? JSON.stringify(aiConf.extra, null, 2) : '';
}
function aiSaveSettings() {
  var c = aiNormalize({
    baseURL: $('#ai-base').value,
    apiKey: $('#ai-key').value,
    model: $('#ai-model').value,
    extra: null
  });
  if (!c.baseURL || !c.model) { toast('错误：API 地址与模型名不能为空', 'err'); return; }
  var rawExtra = $('#ai-extra').value.trim();
  if (rawExtra) {
    try {
      var parsed = JSON.parse(rawExtra);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
      c.extra = parsed;
    } catch (e) { toast('错误：附加请求参数须为 JSON 对象', 'err'); return; }
  }
  var btn = $('#btn-ai-save');
  btn.disabled = true;
  aiSaveConf(c).then(function () {
      toast('AI 设置已保存到笔记仓库（多端同步）', 'ok');
  }).catch(function (e) { toast('保存失败：' + e.message, 'err'); }).finally(function () { btn.disabled = false; });
}

/* ================= 提供商快捷下拉（设置页 AI 区块）：清单来自 /api/ai/providers
   （服务端代理远端 OSS JSON，可随时更新；拉取失败回退内置清单）。
   选中即自动填 baseURL/model + 获取 Key 链接，附加参数清空（思考默认关闭，想开自己加）；
   已保存配置时切换先确认覆盖；「自定义大模型」不动字段由用户手填 ================= */
var AI_PROVIDERS = [
  { id: 'zhipu-free', label: '智谱免费（glm-4.7-flash，免费但不稳定，开放平台 key）', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', keyLink: 'https://bigmodel.cn/apikey/platform', extra: { thinking: { type: 'disabled' } } },
  { id: 'zhipu-fast', label: '智谱快速（glm-5.3-flash，开放平台 key）', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', keyLink: 'https://bigmodel.cn/apikey/platform', extra: { thinking: { type: 'disabled' } } },
  { id: 'zhipu-coding', label: '智谱编程套餐快速（glm-5.3-flash，Coding 套餐 key）', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3-flash', keyLink: 'https://bigmodel.cn/apikey/platform', extra: { thinking: { type: 'disabled' } } },
  { id: 'deepseek', label: '深度求索（deepseek-flash，极速）', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', keyLink: 'https://platform.deepseek.com/api_keys', extra: { thinking: { type: 'disabled' } } },
  { id: 'custom', label: '自定义大模型（手动填写）', baseURL: '', model: '', keyLink: '' }
];
function aiSetKeyLink(url) {
  var a = $('#ai-key-link');
  if (url) {
    a.href = url;
    a.removeAttribute('aria-disabled');
    a.classList.remove('is-off');
  } else {
    a.removeAttribute('href');
    a.setAttribute('aria-disabled', 'true');
    a.classList.add('is-off');
  }
}
function aiRenderProviderOptions() {
  var sel = $('#ai-provider');
  var cur = sel.value;
  sel.innerHTML = '';
  var ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '— 快捷选择提供商 —';
  sel.appendChild(ph);
  AI_PROVIDERS.forEach(function (p) {
    var o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    sel.appendChild(o);
  });
  sel.value = AI_PROVIDERS.some(function (p) { return p.id === cur; }) ? cur : '';
}
function aiLoadProviders() {
  return api('GET', '/ai/providers').then(function (r) {
    if (r && Array.isArray(r.providers) && r.providers.length) {
      AI_PROVIDERS = r.providers;
      aiRenderProviderOptions();
    }
  }).catch(function () {});
}
$('#ai-provider').addEventListener('change', function () {
  var p = null;
  for (var i = 0; i < AI_PROVIDERS.length; i++) if (AI_PROVIDERS[i].id === this.value) { p = AI_PROVIDERS[i]; break; }
  if (!p) return;
  var sel = this;
  var apply = function () {
    $('#ai-base').value = p.baseURL;
    $('#ai-model').value = p.model;
    /* 各家 key 不通用：切提供商（含自定义）一律清空全部输入框，从干净状态开始 */
    $('#ai-key').value = '';
    $('#ai-extra').value = p.extra ? JSON.stringify(p.extra) : '';
    aiSetKeyLink(p.keyLink || '');
    if (p.id === 'custom') $('#ai-base').focus();
  };
  if (p.id === 'custom') {   /* 自定义：直接清空表单进入手填（只动表单，不改已保存配置），无需确认 */
    apply();
    return;
  }
  if (aiConfigured() && aiConf.apiKey) {
    dlg('切换提供商', { text: '将覆盖现有配置，是否同意？', ok: '覆盖' }).then(function (v) {
      if (v) apply();
      else sel.value = '';
    });
  } else {
    apply();
  }
});
aiSetKeyLink('');   /* 初始未选提供商：获取 Key 按钮置灰 */
aiRenderProviderOptions();   /* 先用内置清单渲染，远端拉到后原位替换（失败保持内置） */
aiLoadProviders();

function aiTestConn() {
  var btn = $('#btn-ai-test');
  var out = $('#ai-test-result');
  var base = $('#ai-base').value.trim().replace(/\/+$/, '');
  var model = $('#ai-model').value.trim();
  out.hidden = false;
  if (!base || !model) { out.textContent = '请先填 API 地址与模型名'; out.style.color = 'var(--danger)'; return; }
  btn.disabled = true;
  out.textContent = '测试中…';
  out.style.color = '';
  var extra = {};
  var raw = $('#ai-extra').value.trim();
  if (raw) { try { extra = JSON.parse(raw); } catch (_) { extra = {}; } }
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, 30000);
  fetch('/api/ai/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: base + '/chat/completions', key: $('#ai-key').value.trim(), body: Object.assign({}, extra, { model: model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }) }),
    signal: ac.signal
  }).then(function (r) {
    clearTimeout(timer);
    if (r.ok) { out.textContent = '✓ 连接成功'; out.style.color = 'var(--accent)'; return null; }
    return r.text().catch(function () { return ''; }).then(function (t) {
      out.style.color = 'var(--danger)';
      if (r.status === 404) { out.textContent = '✗ 本地服务缺少代理端点：请更新 git-notes 并重启服务'; return null; }
      if (r.status === 502) { out.textContent = '✗ 无法连接 AI 服务（检查网络与 API 地址）'; return null; }
      out.textContent = r.status === 401 ? '✗ 鉴权失败：检查 API Key' : ('✗ HTTP ' + r.status + '：' + aiClip(String(t).replace(/\s+/g, ' '), 160));
      return null;
    });
  }).catch(function (e) {
    clearTimeout(timer);
    out.style.color = 'var(--danger)';
    out.textContent = e.name === 'AbortError' ? '✗ 超时（30s）' : '✗ 本地服务不可达';
  }).finally(function () { btn.disabled = false; });
}

/* ================= 页面归属（窄屏 AI 整页 / 宽屏 ≥1024px 恒双栏右栏）
   布局全部由 showView（20-util.js）驱动：.view.on + #shell.dual，本文件只管 AI 页内部。 ================= */
function aiBack() {   /* Android 返回键桥（MainActivity 调用）：AI 页时回信息流；返回 true=已消费 */
  if (curView === 'ai' && !wideMq.matches) {
    $('#ai-sessions').hidden = true;
    showView('feed');
    return true;
  }
  return false;
}

/* ================= 会话持久化（UI 事件流；工具载荷不入库；LRU 50） ================= */
var aiSessions = [];
var aiCurId = null;
function aiLoadSessions() {
  try { aiSessions = JSON.parse(localStorage.getItem('gnAiSessions') || '[]'); } catch (_) { aiSessions = []; }
  if (!Array.isArray(aiSessions)) aiSessions = [];
  aiSessions = aiSessions.filter(function (s) { return s && s.id && Array.isArray(s.events); });
  try { aiCurId = localStorage.getItem('gnAiSessionCur') || null; } catch (_) { aiCurId = null; }
  if (!aiFindSession(aiCurId)) aiCurId = aiSessions.length ? aiSessions[0].id : null;
}
function aiFindSession(id) {
  for (var i = 0; i < aiSessions.length; i++) if (aiSessions[i].id === id) return aiSessions[i];
  return null;
}
function aiCur() { return aiFindSession(aiCurId); }
function aiSaveSessions() {
  if (aiSessions.length > 50) aiSessions = aiSessions.slice(0, 50);
  try { localStorage.setItem('gnAiSessions', JSON.stringify(aiSessions)); } catch (_) {}
  try { localStorage.setItem('gnAiSessionCur', aiCurId || ''); } catch (_) {}
}
function aiEnsureSession() {
  if (aiCur()) return aiCur();
  var s = { id: 's' + Date.now() + Math.random().toString(36).slice(2, 6), title: '', at: Date.now(), events: [] };
  aiSessions.unshift(s);
  aiCurId = s.id;
  aiSaveSessions();
  return s;
}
function aiNewSession() {
  aiCurId = null;
  aiEnsureSession();
  aiSaveSessions();
  aiRenderAll();
  $('#ai-input').focus();
}
function aiPushEvent(ev) {
  var s = aiEnsureSession();
  if (ev.t === 'u' && !s.title) { s.title = String(ev.x || '').slice(0, 24); s.at = Date.now(); }
  s.events.push(ev);
  aiSaveSessions();
  aiAppendEvent(ev);
}
function aiDeleteSession(id) {
  aiSessions = aiSessions.filter(function (s) { return s.id !== id; });
  if (aiCurId === id) aiCurId = aiSessions.length ? aiSessions[0].id : null;
  aiSaveSessions();
  aiRenderAll();
  aiRenderSessionsPanel();
}
function aiSwitchSession(id) {
  aiCurId = id;
  aiSaveSessions();
  aiRenderAll();
  aiRenderSessionsPanel();
}

/* ================= 渲染（全部 createElement/textContent，模型内容不经 innerHTML） ================= */
function aiEl(tag, cls) { var d = document.createElement(tag); if (cls) d.className = cls; return d; }
function aiClip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function aiScrollBottom() {
  var box = $('#ai-msgs');
  box.scrollTop = box.scrollHeight;
}

function aiRenderAll() {
  var box = $('#ai-msgs');
  box.innerHTML = '';
  var s = aiCur();
  if (s) s.events.forEach(aiAppendEvent);
  aiRenderUnconfig();
}
function aiAppendEvent(e) {
  var node = aiRenderEventNode(e);
  $('#ai-msgs').appendChild(node);
  aiScrollBottom();
  return node;
}
function aiRenderEventNode(e) {
  if (e.t === 'u') {
    var d = aiEl('div', 'ai-msg user');
    d.textContent = e.x;
    return d;
  }
  if (e.t === 'a') return aiAssistantNode(e.x, e.rk || '', e.cites || [], e.stop);
  if (e.t === 'act') { var a = aiEl('div', 'ai-act'); a.textContent = '⚙ ' + e.x; return a; }
  if (e.t === 'err') { var er = aiEl('div', 'ai-act err'); er.textContent = '⚠ ' + e.x; return er; }
  if (e.t === 'cf') {
    var c = aiEl('div', 'ai-confirm done');
    var h = aiEl('h4'); h.textContent = 'AI 请求' + (AI_TOOL_LABEL[e.tool] || e.tool) + '——已' + (e.rs === 'allow' ? '允许' : '拒绝');
    c.appendChild(h);
    c.appendChild(aiConfirmList(e.items));
    return c;
  }
  return aiEl('div');
}
function aiConfirmList(items) {
  var ul = aiEl('ul');
  (items || []).forEach(function (x) { var li = aiEl('li'); li.textContent = x; ul.appendChild(li); });
  return ul;
}
/* assistant 气泡：思考折叠 + markdown 正文 + 引用卡片 */
function aiAssistantNode(text, reasoning, cites, stopped) {
  var root = aiEl('div', 'ai-msg assistant');
  var body = String(text || '');
  if (reasoning) {
    var dt = aiEl('details', 'ai-think');
    var sm = aiEl('summary'); sm.textContent = '思考过程'; dt.appendChild(sm);
    var tb = aiEl('div', 'ai-think-body'); tb.textContent = reasoning; dt.appendChild(tb);
    root.appendChild(dt);
  }
  if (body) {
    var md = aiEl('div');
    aiMdRender(md, body);
    aiAppendCiteCards(md, cites);
    root.appendChild(md);
  }
  if (stopped) {
    var sp = aiEl('div', 'ai-act'); sp.style.marginTop = '6px'; sp.textContent = '已停止生成（保留以上内容）';
    root.appendChild(sp);
  }
  return root;
}
/* 引用卡片：chip 点击时展开对应卡片 */
function aiAppendCiteCards(md, cites) {
  if (!cites || !cites.length) return;
  var box = aiEl('div', 'ai-cites');
  cites.forEach(function (c) {
    var card = aiEl('div', 'ai-cite-card');
    card.setAttribute('data-cite-path', c.path);
    var head = aiEl('div', 'ai-cite-head');
    var ct = aiEl('span', 'ct'); ct.textContent = c.time || c.path;
    head.appendChild(ct);
    if (c.tags && c.tags.length) { var tg = aiEl('span'); tg.textContent = c.tags.join('、'); head.appendChild(tg); }
    var ex = aiEl('span'); ex.textContent = aiClip(String(c.ex || '').replace(/\s+/g, ' '), 46); head.appendChild(ex);
    card.appendChild(head);
    var bodyEl = aiEl('div', 'ai-cite-body');
    bodyEl.textContent = (aiSeen[c.path] && aiSeen[c.path].text) || c.ex || '（正文未缓存，仅摘要）';
    bodyEl.hidden = true;
    card.appendChild(bodyEl);
    head.onclick = function () {
      bodyEl.hidden = !bodyEl.hidden;
    };
    box.appendChild(card);
  });
  md.appendChild(box);
}
function aiCiteLabel(path) {
  var p = aiSeen[path];
  var d = p ? (String(p.created || p.stem || '').replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3')) : '';
  return d || path.replace(/^micro\//, '').replace(/\.md$/, '');
}

/* Markdown 白名单渲染：段落/标题/列表/引用/围栏代码/分隔线 + 行内粗斜体与行内代码/链接 */
function aiInline(parent, text) {
  var re = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*)|(https?:\/\/[^\s]+)/g;
  var last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[2] !== undefined) { var c = aiEl('code'); c.textContent = m[2]; parent.appendChild(c); }
    else if (m[4] !== undefined) { var b = aiEl('b'); b.textContent = m[4]; parent.appendChild(b); }
    else if (m[6] !== undefined) { var it = aiEl('i'); it.textContent = m[6]; parent.appendChild(it); }
    else {
      var a = aiEl('a'); a.href = m[7]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = m[7].replace(/[.,;:!?、。！？…）)]$/, '');
      parent.appendChild(a);
      var trail = m[7].slice(a.textContent.length);
      if (trail) parent.appendChild(document.createTextNode(trail));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
var AI_BLOCK_RE = /^\s*(```|#{1,3}\s|>|[-*]\s|\d+[.、]\s|---+\s*$)/;
function aiMdRender(container, text) {
  var md = aiEl('div', 'ai-md');
  var lines = String(text || '').split('\n');
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^\s*```/.test(line)) {
      var pre = aiEl('pre'), code = aiEl('code'), buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      code.textContent = buf.join('\n');
      pre.appendChild(code); md.appendChild(pre);
      continue;
    }
    var hm = /^\s*(#{1,3})\s+(.*)/.exec(line);
    if (hm) { var h = aiEl('h' + hm[1].length); aiInline(h, hm[2]); md.appendChild(h); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { md.appendChild(aiEl('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      var bq = aiEl('blockquote');
      while (i < lines.length) {
        var qm = /^\s*>\s?(.*)/.exec(lines[i]);
        if (!qm) break;
        if (bq.childNodes.length) bq.appendChild(document.createTextNode('\n'));
        aiInline(bq, qm[1]);
        i++;
      }
      md.appendChild(bq);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      var ul = aiEl('ul');
      while (i < lines.length) {
        var um = /^\s*[-*]\s+(.*)/.exec(lines[i]);
        if (!um) break;
        var li = aiEl('li'); aiInline(li, um[1]); ul.appendChild(li); i++;
      }
      md.appendChild(ul);
      continue;
    }
    if (/^\s*\d+[.、]\s+/.test(line)) {
      var ol = aiEl('ol');
      while (i < lines.length) {
        var om = /^\s*\d+[.、]\s+(.*)/.exec(lines[i]);
        if (!om) break;
        var li2 = aiEl('li'); aiInline(li2, om[1]); ol.appendChild(li2); i++;
      }
      md.appendChild(ol);
      continue;
    }
    var p = aiEl('p');
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !AI_BLOCK_RE.test(lines[i])) {
      if (p.childNodes.length) p.appendChild(document.createTextNode('\n'));
      aiInline(p, lines[i]);
      i++;
    }
    md.appendChild(p);
  }
  container.appendChild(md);
  aiLinkCites(md);
  return md;
}
/* [[path]] → 引用 chip（TreeWalker 文本节点替换，不碰元素） */
function aiLinkCites(root) {
  var nodes = [];
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(function (node) {
    var text = node.nodeValue;
    if (!text || text.indexOf('[[') === -1) return;
    var re = /\[\[([^\[\]]+)\]\]/g, m, frag = document.createDocumentFragment(), last = 0, found = false;
    while ((m = re.exec(text))) {
      found = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(aiMakeCite(m[1]));
      last = m.index + m[0].length;
    }
    if (!found) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
}
function aiMakeCite(path) {
  var b = aiEl('button', 'ai-cite');
  b.type = 'button';
  b.textContent = '📄 ' + aiCiteLabel(path);
  b.title = path;
  b.onclick = function () {
    var card = aiNearestCard(b, path);
    if (!card) { toast('该引用不在本轮检索结果中，已忽略', 'err'); return; }
    var bodyEl = card.querySelector('.ai-cite-body');
    if (bodyEl) bodyEl.hidden = false;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  return b;
}
function aiNearestCard(el, path) {
  var msg = el.closest('.ai-msg');
  if (!msg) return null;
  var cards = msg.querySelectorAll('.ai-cite-card');
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute('data-cite-path') === path) return cards[i];
  }
  return null;
}
/* <think> 混入正文时的摘出（DeepSeek 系走 reasoning_content，这里兜底） */
function aiSplitThink(text) {
  var m = /<think>([\s\S]*?)(<\/think>|$)/.exec(String(text || ''));
  if (!m) return { think: '', body: String(text || '') };
  return { think: m[1].trim(), body: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/^\s+|\s+$/g, '') };
}

/* 流式中的临时气泡（结束时移除，正式内容以事件渲染） */
function aiAddAssistantBubble() {
  var root = aiEl('div', 'ai-msg assistant');
  var dt = aiEl('details', 'ai-think'); dt.hidden = true;
  var sm = aiEl('summary'); sm.textContent = '思考过程'; dt.appendChild(sm);
  var tb = aiEl('div', 'ai-think-body'); dt.appendChild(tb);
  root.appendChild(dt);
  var holder = aiEl('div');
  root.appendChild(holder);
  $('#ai-msgs').appendChild(root);
  var pending = null;
  var b = {
    root: root,
    setThink: function (t) {
      dt.hidden = false;
      if (!dt.open && !b.bodyStarted) dt.open = true;
      tb.textContent = t;
      aiScrollBottom();
    },
    setBody: function (t) {
      if (!b.bodyStarted) { b.bodyStarted = true; dt.open = false; }
      if (pending) return;
      pending = setTimeout(function () {
        pending = null;
        holder.innerHTML = '';
        aiMdRender(holder, t);
        aiScrollBottom();
      }, 60);
    },
    done: function () {
      if (pending) { clearTimeout(pending); pending = null; }
      dt.hidden = dt.hidden || !tb.textContent;
      if (tb.textContent) dt.open = false;
    },
    remove: function () { if (root.parentNode) root.parentNode.removeChild(root); }
  };
  aiScrollBottom();
  return b;
}
function aiAddStep(text) {
  var d = aiEl('div', 'ai-act');
  var sp = aiEl('span', 'spin'); d.appendChild(sp);
  var tx = aiEl('span'); tx.textContent = text; d.appendChild(tx);
  $('#ai-msgs').appendChild(d);
  aiScrollBottom();
  return d;
}
function aiAddAct(text) { aiPushEvent({ t: 'act', x: text }); }
function setAiStopVisible(v) { $('#btn-ai-stop').hidden = !v; $('#btn-ai-send').hidden = v; }
function aiRenderUnconfig() {
  var un = aiConfigured();
  $('#ai-unconfig').hidden = un;
  $('#ai-dot').hidden = un;
}
function aiErrText(e) {
  var st = e && e.status;
  if (st === 401 || st === 403) return '鉴权失败：检查 API Key（' + aiClip(e.message, 120) + '）';
  if (st === 404) return '接口不存在：检查 API 地址（OpenAI 兼容地址一般以 /v1 结尾）';
  if (st === 429) return '服务限流或额度不足（429），稍后再试';
  if (e && e.name === 'TypeError') return '本地服务不可达（git-notes 服务可能已停止）';
  return (e && e.message) || '未知错误';
}

/* ================= 工具定义与执行 ================= */
var AI_TOOL_LABEL = {
  set_filter: '筛选信息流', search_notes: '检索笔记', read_notes: '阅读笔记',
  create_notes: '创建笔记', update_notes: '修改笔记', delete_notes: '删除笔记',
  git_history: '查 git 历史', read_note_at: '读历史版本', restore_note: '恢复历史版本',
  fs_list: '列目录', fs_read: '读文件', fs_write: '写文件', fs_delete: '删文件',
  fs_move: '移动/重命名', fs_mkdir: '建目录',
  git_status: '查工作区状态', git_add: '暂存文件', git_commit: '提交',
  git_push: '推送', git_pull: '拉取整合', git_diff: '查差异',
  git_branch: '分支列表', git_restore_files: '恢复文件',
  http_request: '发起 HTTP 请求', web_fetch: '读取网页正文', web_search: '联网搜索'
};
function aiTool(name, desc, props, req) {
  return { type: 'function', function: { name: name, description: desc, parameters: { type: 'object', properties: props, required: req || [] } } };
}
var AI_TOOLS = [
  aiTool('set_filter', '替用户设置信息流筛选（全量替换）：标签 + 时间段 + 全库搜索关键词。三项全空=清除全部筛选。时间格式 YYYY-MM-DD，可单端留空（只填 from=该日至今；只填 to=最早至该日）。', {
    tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 1 个，必须在可用标签清单内' },
    from: { type: 'string', description: '开始日期 YYYY-MM-DD' },
    to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
    query: { type: 'string', description: '全库搜索关键词（服务端支持中文/拼音/拼音首字母，如 banjia、bj）' }
  }),
  aiTool('search_notes', '全库检索笔记（含拼音/首字母匹配）。返回命中帖子的 path、日期、标签与正文片段；需要引用时用返回的 path 写 [[path]]。', {
    query: { type: 'string', description: '搜索词，可多个空格分隔（AND 语义）' },
    from: { type: 'string', description: '可选，限定开始日期 YYYY-MM-DD' },
    to: { type: 'string', description: '可选，限定结束日期 YYYY-MM-DD' },
    max: { type: 'number', description: '最多返回条数，默认 20，上限 20' }
  }, ['query']),
  aiTool('read_notes', '按 path 读取若干笔记全文（检索摘要不够时深读）。', {
    paths: { type: 'array', items: { type: 'string' }, description: '笔记 path 列表，最多 5 个' }
  }, ['paths']),
  aiTool('create_notes', '批量创建微笔记（纯文本+标签，不支持图片附件）。仅在用户明确要求时使用。', {
    notes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['text'] }, description: '要创建的笔记，最多 20 条' }
  }, ['notes']),
  aiTool('update_notes', '批量修改微笔记：可改全文 text，可对标签做增（tags_add）删（tags_remove）。不传 text 则只改标签；图片附件自动保留。', {
    items: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' }, tags_add: { type: 'array', items: { type: 'string' } }, tags_remove: { type: 'array', items: { type: 'string' } } }, required: ['path'] }, description: '修改项，最多 20 条' }
  }, ['items']),
  aiTool('delete_notes', '批量删除微笔记（危险操作；git 历史可找回）。仅在用户明确要求时使用。', {
    paths: { type: 'array', items: { type: 'string' }, description: '要删除的笔记 path，最多 20 条' }
  }, ['paths']),
  aiTool('git_history', '查看笔记仓库的提交历史（可按笔记 path 过滤），用于追溯改动或找回旧版本。', {
    limit: { type: 'number', description: '返回条数，默认 50，上限 200' },
    path: { type: 'string', description: '可选，只看某个笔记 path 的历史' }
  }),
  aiTool('read_note_at', '读取某篇笔记在某次提交时点的全文（配合 git_history 使用）。', {
    path: { type: 'string', description: '笔记 path' },
    commit: { type: 'string', description: '提交 hash（git_history 返回）' }
  }, ['path', 'commit']),
  aiTool('restore_note', '把某篇笔记恢复到某次提交时点的内容（可复活已删除的笔记）。以一次新提交落地，不重写历史。', {
    path: { type: 'string', description: '笔记 path' },
    commit: { type: 'string', description: '提交 hash' }
  }, ['path', 'commit']),
  /* ===== 文件操作组（作用域=笔记仓库内，.git 拒绝；只落盘不提交，提交走 git_add+git_commit） ===== */
  aiTool('fs_list', '列出笔记仓库内某目录的内容（文件/子目录、大小、修改时间）。path 传空=仓库根目录。', {
    path: { type: 'string', description: '目录的仓库相对路径，如 micro/2026/10；空=根目录' }
  }),
  aiTool('fs_read', '读取仓库内任意文件全文（文本直接返回；二进制返回 base64）。上限 10MB。', {
    path: { type: 'string', description: '文件的仓库相对路径' }
  }, ['path']),
  aiTool('fs_write', '创建或覆盖仓库内文件（自动建父目录；覆盖前自动备份到仓库外）。只落盘不提交，写完应建议用 git_add+git_commit 提交。', {
    path: { type: 'string', description: '目标文件的仓库相对路径' },
    content: { type: 'string', description: '文件内容（文本）；encoding 为 base64 时是 base64 串' },
    encoding: { type: 'string', description: '省略=text；base64=二进制内容' }
  }, ['path', 'content']),
  aiTool('fs_delete', '删除仓库内文件（自动备份到仓库外）或空目录。只落盘不提交。', {
    paths: { type: 'array', items: { type: 'string' }, description: '要删除的路径清单，最多 50 个' }
  }, ['paths']),
  aiTool('fs_move', '重命名或移动仓库内的文件/目录（目标已存在则失败）。只落盘不提交。', {
    from: { type: 'string', description: '源路径' },
    to: { type: 'string', description: '目标路径' }
  }, ['from', 'to']),
  aiTool('fs_mkdir', '在仓库内创建目录（自动建父目录）。', {
    path: { type: 'string', description: '目录路径' }
  }, ['path']),
  /* ===== 全量 git 组 ===== */
  aiTool('git_status', '查看笔记仓库工作区状态：当前分支、未跟踪/已修改/已暂存文件清单、领先落后远端提交数。', {}),
  aiTool('git_add', '把显式列出的文件路径加入暂存区（不做全仓 add；要提交全部就把清单列全）。', {
    paths: { type: 'array', items: { type: 'string' }, description: '要暂存的路径清单，最多 200 个' }
  }, ['paths']),
  aiTool('git_commit', '提交暂存区内容。消息遵循仓库规范：笔记文件用「micro: add|update|delete <摘要>」，标签/配置用「settings: ...」，其他文件用「fs: ...」。提交前先用 git_status 确认暂存内容。', {
    message: { type: 'string', description: '提交消息（≤500 字符）' }
  }, ['message']),
  aiTool('git_push', '把本地提交推送到远端（仅绑定远端后可用；推送被拒时会失败并提示，可用 git_pull 整合后重试）。', {}),
  aiTool('git_pull', '拉取并整合远端新提交（优先 rebase，失败转 merge；仍冲突则报错并进入冲突待处理）。只整合不推送。', {}),
  aiTool('git_diff', '查看差异。默认=工作区对 HEAD；from=STAGED 查暂存区；from+to=两个提交之间。可加 path 只看某文件。输出过长会截断。', {
    from: { type: 'string', description: '起始提交 hash、HEAD 或 STAGED（暂存区）' },
    to: { type: 'string', description: '结束提交 hash 或 HEAD' },
    path: { type: 'string', description: '可选，只看某个路径' },
    mode: { type: 'string', description: 'stat=只看变更统计；staged=等价 from=STAGED' }
  }),
  aiTool('git_branch', '列出本地分支（只读）。分支已定死 main，无创建/切换。', {}, ['action']),
  aiTool('git_restore_files', '把指定路径恢复到某次提交时点（恢复到工作区并暂存，不自动提交；确认后用 git_commit 提交）。可找回被删文件。', {
    commit: { type: 'string', description: '提交 hash' },
    paths: { type: 'array', items: { type: 'string' }, description: '要恢复的路径清单，最多 200 个' }
  }, ['commit', 'paths']),
  /* ===== 网络组（请求经本地服务端转发，无 CORS 限制；服务端拒绝内网地址） ===== */
  aiTool('http_request', '发起任意 HTTP 请求（GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS），返回状态码、Content-Type 与响应正文（超长截断）。可用于调用任意 REST API（如 Gitee API：GET https://gitee.com/api/v5/user/keys?access_token=xxx）。GET/HEAD/OPTIONS 直接执行，其余方法需用户确认。', {
    url: { type: 'string', description: '完整 URL，http/https' },
    method: { type: 'string', description: 'HTTP 方法，默认 GET' },
    headers: { type: 'object', description: '请求头键值对（如 Authorization）；host/content-length 等逐跳头会被忽略' },
    body: { type: 'string', description: '请求体（POST/PUT/PATCH/DELETE 时生效）；JSON 请自行 stringify' },
    timeout_ms: { type: 'number', description: '超时毫秒，默认 20000，上限 60000' },
    max_bytes: { type: 'number', description: '响应截断字节数，默认 512KB，上限 5MB' },
    encoding: { type: 'string', description: 'base64=以 base64 返回（二进制响应自动启用）' }
  }, ['url']),
  aiTool('web_fetch', '读取网页并提取正文文本（去脚本/导航/页脚，保留链接为「文字 (URL)」）。仅静态 HTML——SPA/懒加载页可能取不到内容，可改用 http_request 拿原始响应。', {
    url: { type: 'string', description: '网页 URL，http/https' },
    max_length: { type: 'number', description: '返回正文的最多字符数，默认 8000' }
  }, ['url']),
  aiTool('web_search', '联网搜索（Firecrawl 搜索引擎），返回标题、URL 与摘要列表，需要内容详情时再用 web_fetch 读具体 URL。默认匿名免费调用（有日配额）；配额用尽时按返回提示引导用户提供 API Key。', {
    query: { type: 'string', description: '搜索词' },
    limit: { type: 'number', description: '结果条数，默认 5，上限 10' },
    lang: { type: 'string', description: '结果语言偏好，如 zh / en' },
    country: { type: 'string', description: '国家偏好，如 cn / us' },
    tbs: { type: 'string', description: '时间过滤（Google tbs 语法），如 qdr:d=近一天、qdr:w=近一周、qdr:m=近一月' },
    api_key: { type: 'string', description: 'Firecrawl API Key（仅配额不足且用户提供后传入）' }
  }, ['query'])
];
function aiToolsForMode(mode) {
  if (mode !== 'ro') return AI_TOOLS;
  return AI_TOOLS.filter(function (t) {
    if (typeof AI_RO_TOOLS !== 'undefined' && AI_RO_TOOLS.indexOf(t.function.name) > -1) return true;
    return ['set_filter', 'search_notes', 'read_notes', 'git_history', 'read_note_at', 'fs_list', 'fs_read', 'git_status', 'git_diff', 'web_fetch', 'web_search'].indexOf(t.function.name) > -1;
  });
}
function aiNeedGate(name) {
  if (typeof AI_GATE_TOOLS !== 'undefined' && AI_GATE_TOOLS.indexOf(name) > -1) return true;
  return ['create_notes', 'update_notes', 'delete_notes', 'restore_note',
    'fs_write', 'fs_delete', 'fs_move', 'fs_mkdir',
    'git_add', 'git_commit', 'git_push', 'git_pull', 'git_restore_files',
    'http_request'].indexOf(name) > -1
}
var aiGrants = {};   /* 会话内「不再询问」豁免：toolName -> true */
var aiSeen = {};     /* path -> 完整 post（引用卡片全文用；截断只影响给模型的文本） */

function aiInRange(p, from, to) {
  var day = (p.stem || p.created || '').slice(0, 8);
  if (!/^\d{8}$/.test(day)) return true;
  if (from && day < String(from).replace(/-/g, '')) return false;
  if (to && day > String(to).replace(/-/g, '')) return false;
  return true;
}
function aiPathMonth(p) {
  var m = /^micro\/(\d{4})\/(\d{2})\//.exec(String(p));
  return m ? m[1] + m[2] : '';
}
function aiPostDate(p) {
  var s = String(p.created || p.stem || '');
  return s.length >= 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
}
function aiFetchPosts(paths) {
  var byMonth = {};
  paths.forEach(function (p) {
    var ym = aiPathMonth(p);
    if (!ym) return;
    if (!byMonth[ym]) byMonth[ym] = [];
    byMonth[ym].push(p);
  });
  var acc = {};
  return Object.keys(byMonth).reduce(function (pr, ym) {
    return pr.then(function () {
      return apiPosts(String(Number(ym) + 1)).then(function (r) {
        (r.posts || []).forEach(function (p) { aiSeen[p.path] = p; acc[p.path] = p; });
      });
    });
  }, Promise.resolve()).then(function () { return acc; });
}
function aiSerial(list, fn) {
  var results = [];
  return list.reduce(function (pr, item) {
    return pr.then(function () {
      return fn(item).catch(function (e) {
        if (e && e.status === 409) return new Promise(function (res) { setTimeout(res, 1500); }).then(function () { return fn(item); });
        return { error: (e && e.message) || '失败' };
      });
    }).then(function (r) { results.push(r); });
  }, Promise.resolve()).then(function () { return results; });
}
/* AI 写入落盘后刷新信息流（搜索态不动——searchHits 里本就没有新帖，刷新由用户手动触发） */
function aiRefreshFeed() {
  if (state.query || !state.ready) return;
  initFeed().then(function () { if (!feed.error) settleStatus(); });
}

function tSetFilter(a) {
  var tag = (a.tags && a.tags[0]) || '';
  if (a.tags && a.tags.length > 1) return Promise.resolve('错误：当前版本一次只支持一个标签筛选，请只传一个。');
  if ((a.from && !/^\d{4}-\d{2}-\d{2}$/.test(a.from)) || (a.to && !/^\d{4}-\d{2}-\d{2}$/.test(a.to)))
    return Promise.resolve('错误：日期格式须为 YYYY-MM-DD');
  var apply = function () {
    var known = state.tags.slice();
    seenTags().forEach(function (t) { if (known.indexOf(t) === -1) known.push(t); });
    if (tag && known.indexOf(tag) === -1) return Promise.resolve('错误：标签「' + tag + '」不存在。可用标签：' + known.join('、'));
    setFilter(tag);
    var sp = runSearch(a.query || '');
    return Promise.resolve(sp).then(function () { return setTimeRange(a.from || null, a.to || null); }).then(function () {
      var tr = (a.from || a.to) ? ((a.from || '最早') + ' ~ ' + (a.to || '今天')) : '不限';
      return '已应用筛选 → 标签:' + (tag || '不限') + ' | 时间:' + tr + ' | 关键词:' + (a.query || '无') + '；信息流当前显示 ' + visiblePosts().length + ' 条';
    });
  };
  return state.ready ? apply() : Promise.resolve('错误：仓库尚未就绪');
}
function tSearch(a) {
  var q = String(a.query || '').trim();
  if (!q) return Promise.resolve('错误：query 不能为空');
  return apiSearch(q).then(function (r) {
    var hits = (r.hits || []).filter(function (p) { return aiInRange(p, a.from, a.to); });
    hits = hits.slice(0, Math.min(Math.max(Number(a.max) || 20, 1), 20));
    hits.forEach(function (p) { aiSeen[p.path] = p; });
    if (!hits.length) return '没有命中（全库共 ' + (r.total || 0) + ' 条）。可尝试更换或减少关键词；支持拼音/首字母（如 banjia、bj）。';
    var lines = hits.map(function (p) {
      return '- ' + p.path + ' | ' + aiPostDate(p) + ' | 标签[' + p.tags.join(',') + ']\n  ' + aiClip(String(p.text || '').replace(/\s+/g, ' '), 800);
    });
    return '命中 ' + hits.length + ' 条（全库 ' + (r.total || 0) + ' 条）：\n' + lines.join('\n');
  });
}
function tRead(a) {
  var paths = (a.paths || []).filter(function (x) { return typeof x === 'string'; }).slice(0, 5);
  if (!paths.length) return Promise.resolve('错误：paths 不能为空（最多 5 个）');
  return aiFetchPosts(paths).then(function (acc) {
    return paths.map(function (p) {
      var post = acc[p] || aiSeen[p];
      if (!post) return '=== ' + p + '\n未找到（可能已被删除或 path 有误）';
      return '=== ' + p + ' | ' + aiPostDate(post) + ' | 标签[' + post.tags.join(',') + ']\n' + aiClip(post.text, 3000);
    }).join('\n\n');
  });
}
function tCreate(a) {
  var notes = (a.notes || []).slice(0, 20);
  if (!notes.length) return Promise.resolve('错误：notes 不能为空');
  var items = notes.map(function (n, i) {
    return (i + 1) + '. ' + aiClip(String(n.text || '').replace(/\s+/g, ' '), 42) + (n.tags && n.tags.length ? '（标签:' + n.tags.join(',') + '）' : '');
  });
  return aiGate('create_notes', items, notes.length).then(function (ok) {
    if (!ok) return '用户拒绝了本次创建操作。';
    return aiSerial(notes, function (n) {
      return apiCreatePost({ text: String(n.text || ''), tags: Array.isArray(n.tags) ? n.tags.slice(0, 8) : [], ai: 1 });
    }).then(function (rs) {
      var okLines = [], failLines = [];
      rs.forEach(function (r, i) {
        if (r && r.path) { aiSeen[r.path] = r; okLines.push('- ' + r.path); }
        else failLines.push('- 第 ' + (i + 1) + ' 条：' + ((r && r.error) || '失败'));
      });
      if (okLines.length) aiRefreshFeed();
      return '已创建 ' + okLines.length + '/' + notes.length + ' 篇\n' + okLines.join('\n') + (failLines.length ? '\n失败：\n' + failLines.join('\n') : '');
    });
  });
}
function tUpdate(a) {
  var items = (a.items || []).filter(function (x) { return x && x.path; }).slice(0, 20);
  if (!items.length) return Promise.resolve('错误：items 不能为空（每项须含 path）');
  return aiFetchPosts(items.map(function (x) { return x.path; })).then(function (acc) {
    var desc = items.map(function (x, i) {
      var cur = acc[x.path] || aiSeen[x.path];
      var parts = [(i + 1) + '. ' + (cur ? aiClip(String(cur.text).replace(/\s+/g, ' '), 30) : x.path)];
      if (x.text != null) parts.push('→「' + aiClip(String(x.text).replace(/\s+/g, ' '), 30) + '」');
      if (x.tags_add && x.tags_add.length) parts.push('加标签:' + x.tags_add.join(','));
      if (x.tags_remove && x.tags_remove.length) parts.push('去标签:' + x.tags_remove.join(','));
      return parts.join(' ');
    });
    return aiGate('update_notes', desc, items.length).then(function (ok) {
      if (!ok) return '用户拒绝了本次修改。';
      return aiSerial(items, function (x) {
        var cur = acc[x.path] || aiSeen[x.path];
        if (!cur) return Promise.resolve({ path: x.path, error: '未找到该笔记' });
        var tags = cur.tags.slice();
        (x.tags_add || []).forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); });
        (x.tags_remove || []).forEach(function (t) { tags = tags.filter(function (y) { return y !== t; }); });
        return apiUpdatePost({ path: x.path, text: x.text != null ? String(x.text) : cur.text, tags: tags, ai: 1 });
      }).then(function (rs) {
        var okN = rs.filter(function (r) { return r && r.path; }).length;
        if (okN) aiRefreshFeed();
        return '已修改 ' + okN + '/' + items.length + ' 篇' + (okN < items.length ? '（其余失败或未找到）' : '');
      });
    });
  });
}
function tDelete(a) {
  var paths = (a.paths || []).filter(function (x) { return typeof x === 'string'; }).slice(0, 20);
  if (!paths.length) return Promise.resolve('错误：paths 不能为空');
  var items = paths.map(function (p, i) {
    var meta = aiSeen[p];
    return (i + 1) + '. ' + aiPostDate(meta || { created: '' }) + ' ' + aiClip(meta ? String(meta.text).replace(/\s+/g, ' ') : p, 36);
  });
  return aiGate('delete_notes', items, paths.length).then(function (ok) {
    if (!ok) return '用户拒绝了本次删除操作。';
    return aiSerial(paths, function (p) { return apiDeletePost(p); }).then(function (rs) {
      var okN = rs.filter(function (r) { return r && !r.error; }).length;
      paths.forEach(function (p) { delete aiSeen[p]; });
      if (okN) aiRefreshFeed();
      return '已删除 ' + okN + '/' + paths.length + ' 篇（git 历史可找回）';
    });
  });
}
function tGitLog(a) {
  var limit = Math.min(Math.max(Number(a.limit) || 50, 1), 200);
  var q = '/git/log?limit=' + limit + (a.path ? '&path=' + encodeURIComponent(a.path) : '');
  return api('GET', q).then(function (r) {
    var list = r.commits || [];
    if (!list.length) return '（无提交记录）';
    return list.map(function (c) { return c.hash.slice(0, 10) + ' ' + (c.date || '').replace('T', ' ').slice(0, 16) + ' ' + c.subject; }).join('\n');
  });
}
function tGitShow(a) {
  if (!a.path || !a.commit) return Promise.resolve('错误：path 与 commit 必填');
  return api('GET', '/git/show?path=' + encodeURIComponent(a.path) + '&commit=' + encodeURIComponent(a.commit)).then(function (r) { return String(r.text || ''); });
}
function tRestore(a) {
  if (!a.path || !a.commit) return Promise.resolve('错误：path 与 commit 必填');
  return api('GET', '/git/show?path=' + encodeURIComponent(a.path) + '&commit=' + encodeURIComponent(a.commit)).then(function (r) {
    return aiGate('restore_note', ['把 ' + a.path + ' 恢复到提交 ' + String(a.commit).slice(0, 10) + ' 时点的内容：\n' + aiClip(String(r.text || '').replace(/\s+/g, ' '), 60)], 1).then(function (ok) {
      if (!ok) return '用户拒绝了本次恢复。';
      return api('POST', '/git/restore', { path: a.path, commit: a.commit, ai: 1 }).then(function () {
        delete aiSeen[a.path];
        aiRefreshFeed();
        return '已恢复 ' + a.path + '（以新提交落地，可继续用 git_history 核对）';
      });
    });
  });
}
/* ===== 文件操作执行器：作用域与安全由服务端 assertRepoPath 把关，前端只做展示与确认门 ===== */
function tFsList(a) {
  return api('GET', '/fs/list?path=' + encodeURIComponent(a.path || '')).then(function (r) {
    if (!r.entries.length) return '（空目录：' + (r.path || '仓库根') + '）';
    var lines = r.entries.map(function (e) {
      var sz = e.type === 'dir' ? '' : ' ' + (e.size > 1024 ? Math.round(e.size / 1024) + 'KB' : e.size + 'B');
      return '- ' + (e.type === 'dir' ? '[目录] ' : '') + e.name + sz;
    });
    return (r.path ? r.path : '仓库根') + '（' + r.count + ' 项）：\n' + lines.join('\n');
  });
}
function tFsRead(a) {
  if (!a.path) return Promise.resolve('错误：path 必填');
  return api('GET', '/fs/read?path=' + encodeURIComponent(a.path)).then(function (r) {
    if (r.encoding === 'base64') return '=== ' + r.path + '（二进制 ' + r.size + ' 字节，base64 略）\n（如需内容请改读文本文件）';
    return '=== ' + r.path + '（' + r.size + ' 字节）\n' + aiClip(String(r.content || ''), 12000);
  });
}
function tFsWrite(a) {
  if (!a.path || a.content == null) return Promise.resolve('错误：path 与 content 必填');
  var preview = String(a.content);
  var isB64 = a.encoding === 'base64';
  var desc = a.path + '（' + (isB64 ? 'base64，' : '') + preview.length + ' 字符）\n开头：' + aiClip(preview.replace(/\s+/g, ' '), 80);
  return aiGate('fs_write', [desc], 1).then(function (ok) {
    if (!ok) return '用户拒绝了本次写入。';
    return api('POST', '/fs/write', { path: a.path, content: a.content, encoding: isB64 ? 'base64' : undefined }).then(function (r) {
      return '已写入 ' + r.path + '（' + r.size + ' 字节' + (r.overwrote ? '，覆盖前已备份' : '') + '）。注意：仅落盘未提交，建议 git_add + git_commit。';
    });
  });
}
function tFsDelete(a) {
  var paths = (a.paths || []).filter(function (x) { return typeof x === 'string'; }).slice(0, 50);
  if (!paths.length) return Promise.resolve('错误：paths 不能为空');
  return aiGate('fs_delete', paths, paths.length).then(function (ok) {
    if (!ok) return '用户拒绝了本次删除。';
    return api('POST', '/fs/delete', { paths: paths }).then(function (r) {
      var okN = (r.results || []).filter(function (x) { return x.deleted; }).length;
      return '已删除 ' + okN + '/' + paths.length + ' 项（删除前自动备份）。仅落盘未提交，建议 git_add -u 类操作改为 git_add 显式清单 + git_commit。'
        + (r.results || []).filter(function (x) { return x.error; }).map(function (x) { return '\n失败：' + x.path + '（' + x.error + '）'; }).join('');
    });
  });
}
function tFsMove(a) {
  if (!a.from || !a.to) return Promise.resolve('错误：from 与 to 必填');
  return aiGate('fs_move', [a.from + ' → ' + a.to], 1).then(function (ok) {
    if (!ok) return '用户拒绝了本次移动。';
    return api('POST', '/fs/move', { from: a.from, to: a.to }).then(function () {
      return '已移动 ' + a.from + ' → ' + a.to + '。仅落盘未提交，建议 git_add（新旧路径都要）+ git_commit。';
    });
  });
}
function tFsMkdir(a) {
  if (!a.path) return Promise.resolve('错误：path 必填');
  return aiGate('fs_mkdir', [a.path], 1).then(function (ok) {
    if (!ok) return '用户拒绝了本次创建。';
    return api('POST', '/fs/mkdir', { path: a.path }).then(function () { return '已创建目录 ' + a.path; });
  });
}
/* ===== 全量 git 执行器 ===== */
function tGitStatus() {
  return api('GET', '/git/status').then(function (r) {
    var head = '分支 ' + r.branch + (r.upstream ? '（跟踪 ' + r.upstream + (r.ahead ? '，领先 ' + r.ahead : '') + (r.behind ? '，落后 ' + r.behind : '') + '）' : '') + '，工作区' + (r.clean ? '干净' : '有 ' + r.count + ' 处变动') + '：';
    if (r.clean) return head + '\n（无变动）';
    var xName = { ' ': ' ', '?': '未跟踪', A: '新增', M: '已修改', D: '已删除', R: '重命名', C: '复制', U: '冲突' };
    var lines = r.entries.map(function (e) {
      return '- [' + (xName[e.x] || e.x) + '/' + (xName[e.y] || e.y) + '] ' + e.path;
    });
    return head + '\n' + lines.join('\n');
  });
}
function tGitAdd(a) {
  var paths = (a.paths || []).filter(function (x) { return typeof x === 'string'; }).slice(0, 200);
  if (!paths.length) return Promise.resolve('错误：paths 不能为空');
  return aiGate('git_add', paths, paths.length).then(function (ok) {
    if (!ok) return '用户拒绝了本次暂存。';
    return api('POST', '/git/add', { paths: paths }).then(function (r) {
      return '已暂存 ' + paths.length + ' 个路径，暂存区现有 ' + r.stagedCount + ' 项。可用 git_commit 提交。';
    });
  });
}
function tGitCommit(a) {
  var msg = String(a.message || '').trim();
  if (!msg) return Promise.resolve('错误：message 必填');
  return api('GET', '/git/status').then(function (st) {
    var staged = (st.entries || []).filter(function (e) { return e.x !== ' ' && e.x !== '?'; });
    if (!staged.length) return '暂存区为空：先用 git_add 暂存文件再提交。';
    return aiGate('git_commit', ['消息：' + msg].concat(staged.map(function (e) { return '- ' + e.path; })), staged.length).then(function (ok) {
      if (!ok) return '用户拒绝了本次提交。';
      return api('POST', '/git/commit', { message: msg }).then(function (r) {
        return '已提交 ' + r.hash + '「' + r.message + '」' + (r.unpushed ? '，本地还有 ' + r.unpushed + ' 个未推送提交（可用 git_push）' : '');
      });
    });
  });
}
function tGitPush() {
  return aiGate('git_push', ['把本地提交推送到远端'], 1).then(function (ok) {
    if (!ok) return '用户拒绝了本次推送。';
    return api('POST', '/git/push', {}).then(function () { return '已推送到远端'; });
  });
}
function tGitPull() {
  return aiGate('git_pull', ['拉取并整合远端新提交（rebase→merge）'], 1).then(function (ok) {
    if (!ok) return '用户拒绝了本次拉取。';
    return api('POST', '/git/pull', {}).then(function (r) {
      if (r.pulled) { aiRefreshFeed(); return '已整合远端 ' + r.integrated + ' 个新提交'; }
      return r.note || '远端无新提交';
    });
  });
}
function tGitDiff(a) {
  var q = [];
  if (a.from) q.push('from=' + encodeURIComponent(a.from));
  if (a.to) q.push('to=' + encodeURIComponent(a.to));
  if (a.path) q.push('path=' + encodeURIComponent(a.path));
  if (a.mode) q.push('mode=' + encodeURIComponent(a.mode));
  return api('GET', '/git/diff' + (q.length ? '?' + q.join('&') : '')).then(function (r) {
    if (!String(r.text || '').trim()) return '（无差异）';
    return '$ ' + r.command + '\n' + String(r.text || '');
  });
}
function tGitBranch() {
  return api('POST', '/git/branch', { action: 'list' }).then(function (r) {
    return '本地分支：\n' + (r.branches || []).map(function (b) { return (b.current ? '* ' : '  ') + b.name; }).join('\n') + (r.remote ? '\n远端：' + r.remote : '（仅本机模式）');
  });
}
function tGitRestoreFiles(a) {
  var paths = (a.paths || []).filter(function (x) { return typeof x === 'string'; }).slice(0, 200);
  if (!a.commit || !paths.length) return Promise.resolve('错误：commit 与 paths 必填');
  return aiGate('git_restore_files', ['恢复到提交 ' + String(a.commit).slice(0, 10) + ' 时点'].concat(paths), paths.length).then(function (ok) {
    if (!ok) return '用户拒绝了本次恢复。';
    return api('POST', '/git/restore-files', { commit: a.commit, paths: paths }).then(function (r) {
      if (paths.some(function (p) { return /^micro\//.test(p); })) aiRefreshFeed();
      return '已恢复 ' + paths.length + ' 个路径到工作区并暂存（未提交），确认后用 git_commit 提交。';
    });
  });
}
/* ===== 网络组执行器：HTTP 由本地服务端转发（无 CORS、拒内网），网页正文抽取在浏览器端用 DOMParser 完成 ===== */
function tHttpRequest(a) {
  var url = String(a.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return Promise.resolve('错误：url 必须以 http(s):// 开头');
  var method = String(a.method || 'GET').toUpperCase();
  var doReq = function () {
    return api('POST', '/http/request', {
      url: url, method: method,
      headers: (a.headers && typeof a.headers === 'object' && !Array.isArray(a.headers)) ? a.headers : {},
      body: a.body != null ? String(a.body) : undefined,
      timeout_ms: a.timeout_ms, max_bytes: a.max_bytes, encoding: a.encoding
    }).then(function (r) {
      var head = 'HTTP ' + r.status + ' | ' + (r.content_type || '无 Content-Type') + ' | ' + r.size + ' 字节' + (r.truncated ? '（已截断）' : '') + (r.final_url && r.final_url !== url ? ' | 重定向至 ' + r.final_url : '');
      var text = r.encoding === 'base64'
        ? '（二进制响应，base64 共 ' + r.size + ' 字节，此处略——如需内容请改用文本类接口）'
        : aiClip(String(r.text || ''), 12000);
      return head + '\n' + text;
    }, function (e) {
      return '请求失败：' + ((e && e.message) || e);
    });
  };
  if (['GET', 'HEAD', 'OPTIONS'].indexOf(method) > -1) return doReq();
  return aiGate('http_request', [method + ' ' + url], 1).then(function (ok) {
    return ok ? doReq() : '用户拒绝了本次请求。';
  });
}
function aiResolveUrl(href, base) {
  try { return new URL(href, base).href; } catch (_) { return href; }
}
function tWebFetch(a) {
  var url = String(a.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return Promise.resolve('错误：url 必须以 http(s):// 开头');
  var maxLen = Math.min(Math.max(Number(a.max_length) || 8000, 200), 30000);
  return api('POST', '/http/request', { url: url, method: 'GET', max_bytes: 1048576, timeout_ms: 20000 }).then(function (r) {
    if (r.status >= 400) return 'HTTP ' + r.status + '，无法读取该网页' + (r.final_url && r.final_url !== url ? '（重定向至 ' + r.final_url + '）' : '');
    var html = String(r.text || '');
    if (!/<[a-z!/]/i.test(html)) return html ? aiClip(html, maxLen) : '（响应为空）';
    var doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,iframe,canvas,template,form,button,input,select,textarea,nav,header,footer,aside').forEach(function (el) { el.remove(); });
    var main = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    if (!main) return '（页面无正文）';
    var base = r.final_url || url;
    var baseEl = doc.querySelector('base[href]');
    if (baseEl) base = aiResolveUrl(baseEl.getAttribute('href'), base);
    main.querySelectorAll('a[href]').forEach(function (el) {
      var abs = aiResolveUrl(el.getAttribute('href') || '', base);
      if (/^https?:\/\//.test(abs) && el.textContent.trim()) el.appendChild(document.createTextNode(' (' + abs + ')'));
    });
    /* 块级元素后补换行，保住段落结构 */
    main.querySelectorAll('br,p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote,pre,section,td,th,figure').forEach(function (el) {
      el.appendChild(document.createTextNode('\n'));
    });
    var text = String(main.textContent || '').replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 100) {   /* 正文抽取过少（SPA 等）：回退全页文本 */
      var full = doc.body ? String(doc.body.textContent || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : '';
      if (full.length > text.length) text = full;
    }
    if (!text) return '（页面无正文）';
    return 'HTTP ' + r.status + ' | ' + base + '\n' + aiClip(text, maxLen);
  }, function (e) {
    return '读取失败：' + ((e && e.message) || e);
  });
}
function tWebSearch(a) {
  var q = String(a.query || '').trim();
  if (!q) return Promise.resolve('错误：query 不能为空');
  return api('POST', '/web/search', {
    query: q, limit: a.limit, lang: a.lang, country: a.country, tbs: a.tbs, api_key: a.api_key
  }).then(function (r) {
    if (!r.ok) {
      if (r.quota_exceeded) return '匿名搜索日配额已用尽。请引导用户到 https://www.firecrawl.dev 免费注册并在后台创建 API Key（申请页：https://www.firecrawl.dev/app/api-keys），拿到 Key 后用 api_key 参数重试本次搜索；配额每日重置，也可次日再试。';
      return '搜索失败：' + (r.error || '未知错误');
    }
    var rs = r.results || [];
    if (!rs.length) return '没有搜索结果，可尝试更换或精简关键词。';
    var lines = rs.map(function (x, i) {
      return (i + 1) + '. ' + String(x.title || '(无标题)') + '\n   ' + x.url + '\n   ' + aiClip(String(x.description || '').replace(/\s+/g, ' '), 200);
    });
    return '搜索「' + q + '」命中 ' + rs.length + ' 条（' + (r.auth === 'api-key' ? 'API Key' : '匿名免费') + '）：\n' + lines.join('\n') + '\n需要正文内容时用 web_fetch 读取对应 URL。';
  }, function (e) {
    return '搜索失败：' + ((e && e.message) || e);
  });
}
var AI_EXEC = {
  set_filter: tSetFilter, search_notes: tSearch, read_notes: tRead,
  create_notes: tCreate, update_notes: tUpdate, delete_notes: tDelete,
  git_history: tGitLog, read_note_at: tGitShow, restore_note: tRestore,
  fs_list: tFsList, fs_read: tFsRead, fs_write: tFsWrite, fs_delete: tFsDelete,
  fs_move: tFsMove, fs_mkdir: tFsMkdir,
  git_status: tGitStatus, git_add: tGitAdd, git_commit: tGitCommit,
  git_push: tGitPush, git_pull: tGitPull, git_diff: tGitDiff,
  git_branch: tGitBranch, git_restore_files: tGitRestoreFiles,
  http_request: tHttpRequest, web_fetch: tWebFetch, web_search: tWebSearch
};
function aiExecTool(name, args) {
  var fn = AI_EXEC[name];
  if (!fn) return Promise.resolve('错误：未知工具 ' + name);
  return fn(args || {});
}

/* ================= 权限门（三级模式 + 会话内豁免 + 删除硬底线） ================= */
function aiGate(name, items, count) {
  if (!aiNeedGate(name)) return Promise.resolve(true);
  if (aiGrants[name]) return Promise.resolve(true);
  var mode = aiMode();
  if (mode === 'auto' && !(name === 'delete_notes' && count > 5)) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var card = aiEl('div', 'ai-confirm');
    var h = aiEl('h4');
    h.textContent = 'AI 请求' + (AI_TOOL_LABEL[name] || name) + '（' + count + ' 项）——等待你的确认';
    card.appendChild(h);
    card.appendChild(aiConfirmList(items));
    var ops = aiEl('div', 'ops');
    var ok = aiEl('button'); ok.textContent = '允许'; ok.className = 'primary';
    var no = aiEl('button'); no.textContent = '拒绝';
    var lb = aiEl('label');
    var ck = document.createElement('input'); ck.type = 'checkbox';
    lb.appendChild(ck);
    lb.appendChild(document.createTextNode('本会话内同类操作不再询问'));
    ops.appendChild(ok); ops.appendChild(no); ops.appendChild(lb);
    card.appendChild(ops);
    $('#ai-msgs').appendChild(card);
    aiScrollBottom();
    function finish(yes) {
      card.classList.add('done');
      h.textContent = 'AI 请求' + (AI_TOOL_LABEL[name] || name) + '——已' + (yes ? '允许' : '拒绝');
      ok.disabled = true; no.disabled = true;
      aiPushEvent({ t: 'cf', tool: name, items: items, rs: yes ? 'allow' : 'deny' });
      if (yes && ck.checked) aiGrants[name] = true;
      resolve(yes);
    }
    ok.onclick = function () { finish(true); };
    no.onclick = function () { finish(false); };
  });
}

/* ================= SSE 流式与调用循环 =================
   AI 请求统一走本地同源代理 /api/ai/proxy（服务端转发上游并逐块透传 SSE）。
   部分服务商不支持浏览器跨域（如智谱不回 ACAO），直连没有出路；同源代理对前端零差别。 ================= */
var aiAbort = null;
var aiBusy = false;
var aiCurBubble = null;   /* 流式中的临时气泡：创建即登记（中止发生在 promise 落定前，调用方拿不到返回值） */

function aiUpstreamFetch(payload) {
  return fetch('/api/ai/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: aiAbort.signal
  });
}
function aiChatStream(messages) {
  var c = aiCfg();
  /* 附加请求参数（extra）先合并，保留键（model/messages/stream/tools）以应用自身为准 */
  var chatBody = Object.assign({}, aiConf.extra || {}, { model: c.model, messages: messages, stream: true });
  var tools = aiToolsForMode(aiMode());
  if (tools.length) chatBody.tools = tools;
  return aiUpstreamFetch({ url: c.baseURL + '/chat/completions', key: c.apiKey || '', body: chatBody }).then(function (res) {
    if (!res.ok) {
      return res.text().catch(function () { return ''; }).then(function (t) {
        if (res.status === 404) {
          var e404 = new Error('本地服务缺少 AI 代理端点（/api/ai/proxy）：请更新 git-notes 并重启服务');
          e404.status = 404;
          throw e404;
        }
        if (res.status === 502) {
          var e502 = new Error('无法连接 AI 服务：' + aiClip(String(t).replace(/\s+/g, ' '), 160));
          e502.status = 0;
          throw e502;
        }
        var e = new Error(aiClip(String(t).replace(/\s+/g, ' '), 200) || ('HTTP ' + res.status));
        e.status = res.status;
        throw e;
      });
    }
    var content = '', reasoning = '', done = false;
    var tcs = [];
    var bubble = aiAddAssistantBubble();
    aiCurBubble = bubble;
    function handleDelta(d) {
      var rk = d.reasoning_content !== undefined && d.reasoning_content !== null ? d.reasoning_content : d.reasoning;
      if (rk) { reasoning += rk; bubble.setThink(reasoning); }
      if (d.content) { content += d.content; bubble.setBody(content); }
      if (d.tool_calls) {
        d.tool_calls.forEach(function (t) {
          var idx = typeof t.index === 'number' ? t.index : tcs.length;
          if (!tcs[idx]) tcs[idx] = { id: '', function: { name: '', arguments: '' } };
          if (t.id) tcs[idx].id = t.id;
          if (t.function) {
            if (t.function.name) tcs[idx].function.name += t.function.name;
            if (t.function.arguments) tcs[idx].function.arguments += t.function.arguments;
          }
        });
      }
    }
    function finish() {
      bubble.done();
      var toolCalls = tcs.filter(Boolean).filter(function (t) { return t.function.name; }).map(function (t) {
        return { id: t.id || ('call_' + Math.random().toString(36).slice(2, 10)), type: 'function', function: { name: t.function.name, arguments: t.function.arguments } };
      });
      return { content: content, reasoning: reasoning, toolCalls: toolCalls, bubble: bubble };
    }
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return finish();
        buf += dec.decode(r.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].replace(/\r$/, '');
          if (!line || line.charAt(0) === ':') continue;
          if (line.indexOf('data:') !== 0) continue;
          var s = line.slice(5).trim();
          if (s === '[DONE]') { done = true; continue; }
          var j;
          try { j = JSON.parse(s); } catch (_) { continue; }
          var ch = j.choices && j.choices[0];
          if (ch) handleDelta(ch.delta || ch.message || {});
        }
        if (done) return finish();
        return pump();
      }).catch(function (e) {
        e.partial = { content: content, reasoning: reasoning };
        throw e;
      });
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    return pump();
  });
}
function aiExtractCites(text) {
  var out = [], seenP = {};
  var re = /\[\[([^\[\]]+)\]\]/g, m;
  while ((m = re.exec(String(text || '')))) {
    var p = m[1];
    if (seenP[p]) continue;
    seenP[p] = 1;
    var post = aiSeen[p];
    out.push({ path: p, time: post ? aiPostDate(post) : '', tags: post ? post.tags : [], ex: post ? aiClip(post.text, 120) : '' });
  }
  return out;
}
function aiSystemPrompt() {
  var now = new Date();
  var ds = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  var known = state.tags.slice();
  seenTags().forEach(function (t) { if (known.indexOf(t) === -1) known.push(t); });
  var filt = '标签:' + (state.filter || '无') + ' | 时间:' + (state.timeRange ? ((state.timeRange.from || '最早') + '~' + (state.timeRange.to || '今天')) : '不限') + ' | 搜索:' + (state.query || '无');
  var modeDesc = { ro: '只读模式：你没有写入类工具，只能筛选、检索与回答。', confirm: '确认模式：你的写入/删除/恢复操作会先展示确认卡片，由用户放行后才执行。', auto: '自动模式：写操作会直接执行（删除超过 5 篇仍需用户确认），请格外谨慎。' }[aiMode()];
  return '你是本地微笔记应用「Git笔记」（官网 ' + APP_META.homepage + '，开源 ' + APP_META.github + '）内置的 AI 助手，帮用户筛选信息流、检索与整理笔记。\n'
    + '今天是 ' + ds + ' 星期' + '日一二三四五六'.charAt(now.getDay()) + '（用户本地时区）。「今天/昨天/去年/上月」等相对时间全部以此推算。\n'
    + '可用标签清单：[' + known.join('、') + ']。用户提到的标签尽量对齐清单；清单里没有的标签不要编造，如实说明即可。\n'
    + '当前生效筛选：' + filt + '。\n'
    + '约定：\n'
    + '- 回答用简体中文，只使用普通 Markdown（段落、**粗体**、列表、`行内代码`、代码块、> 引用）；不要表格、图片和任何 HTML。\n'
    + '- 引用具体笔记时在相应位置写 [[笔记path]]，path 必须来自工具返回结果，禁止编造；先检索再回答，不要臆测笔记内容。\n'
    + '- 检索词支持拼音与首字母（如搬家→banjia/bj），一次效果不佳可换词重搜。\n'
    + '- 创建/修改笔记保持用户原有文风；删除是危险操作，仅在用户明确要求时执行，且先 search_notes/read_notes 核对再删。\n'
    + '- set_filter 直接改变用户屏幕上的信息流，用户可见可撤销；用户说「看去年的X」这类诉求时用它。\n'
    + '- 关于应用自身（版本/官网/源码/SSH 密钥/字号/主题/标签清单等），先用 app_info 及相应工具查询，不要凭空回答。\n'
    + '- 你不能做的事（被问到时如实说明并引导用户到设置页手动操作）：修改你自己的模型/API Key/权限模式、绑定或解绑远端仓库、强制推送、导出私钥、触发应用更新。\n'
    + '- 当前权限模式：' + modeDesc;
}
function aiHistMessages() {
  var s = aiCur();
  var out = [];
  (s ? s.events : []).forEach(function (e) {
    if (e.t === 'u') out.push({ role: 'user', content: e.x });
    else if (e.t === 'a' && e.x) out.push({ role: 'assistant', content: e.x });
  });
  return out.slice(-10);
}
function aiToolRoundSummary(name, args, result) {
  var head = String(result || '').split('\n')[0];
  return (AI_TOOL_LABEL[name] || name) + '：' + aiClip(head, 72);
}
async function aiRunTurn() {
  aiBusy = true;
  setAiStopVisible(true);
  aiAbort = new AbortController();
  var messages = [{ role: 'system', content: aiSystemPrompt() }].concat(aiHistMessages());
  var stepEl = aiAddStep('思考中…');
  var curBubble = null;
  try {
    for (var round = 0; round < 12; round++) {
      var res = await aiChatStream(messages);
      curBubble = res.bubble;
      aiCurBubble = null;
      stepEl.remove(); stepEl = null;
      if (res.toolCalls.length) {
        if (res.content) aiPushEvent({ t: 'a', x: res.content, rk: res.reasoning, cites: [] });
        curBubble.remove(); curBubble = null;
        messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls });
        for (var i = 0; i < res.toolCalls.length; i++) {
          var tc = res.toolCalls[i];
          var args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
          stepEl = aiAddStep('执行：' + (AI_TOOL_LABEL[tc.function.name] || tc.function.name) + '…');
          var result;
          try { result = await aiExecTool(tc.function.name, args); }
          catch (e) { result = '工具执行失败：' + ((e && e.message) || e); }
          if (stepEl) { stepEl.remove(); stepEl = null; }
          aiAddAct(aiToolRoundSummary(tc.function.name, args, result));
          messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 8000) });
        }
        stepEl = aiAddStep('思考中…');
        continue;
      }
      var split = aiSplitThink(res.content || '');
      var rk = res.reasoning + (split.think ? (res.reasoning ? '\n' : '') + split.think : '');
      curBubble.remove(); curBubble = null;
      aiPushEvent({ t: 'a', x: split.body, rk: rk, cites: aiExtractCites(split.body) });
      break;
    }
    if (round >= 12) aiPushEvent({ t: 'err', x: '工具轮次已达上限（12），已停止本轮。' });
  } catch (e) {
    if (stepEl) stepEl.remove();
    if (aiCurBubble) { aiCurBubble.remove(); aiCurBubble = null; }
    if (curBubble) curBubble.remove();
    if (e && e.name === 'AbortError') {
      var partial = (e && e.partial && e.partial.content) ? e.partial.content : '';
      if (partial) {
        var ps = aiSplitThink(partial);
        aiPushEvent({ t: 'a', x: ps.body, rk: e.partial.reasoning || '', cites: aiExtractCites(ps.body), stop: true });
      } else {
        aiPushEvent({ t: 'err', x: '已停止生成（尚未收到内容）。' });
      }
    } else {
      aiPushEvent({ t: 'err', x: aiErrText(e) });
    }
  }
  aiBusy = false;
  aiAbort = null;
  setAiStopVisible(false);
  aiRenderUnconfig();
}
function aiStopGen() {
  if (aiAbort) aiAbort.abort();
}

/* ================= 事件绑定与初始化 ================= */
$('#btn-ai-new').onclick = aiNewSession;
$('#btn-ai-goconfig').onclick = function () { showView('set'); };
$('#btn-ai-send').onclick = aiSendText;
$('#btn-ai-stop').onclick = aiStopGen;
$('#ai-input').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); aiSendText(); }
});
$('#ai-input').addEventListener('input', function () { autoGrow(this); });
$('#btn-ai-sessions').onclick = function () {
  var p = $('#ai-sessions');
  if (p.hidden) { aiRenderSessionsPanel(); p.hidden = false; }
  else p.hidden = true;
};
/* 权限模式三段胶囊：点击即切换（只写本机 localStorage，不发请求） */
$('#ai-mode-pills').addEventListener('click', function (ev) {
  var btn = ev.target.closest('[data-ai-mode]');
  if (!btn || btn.disabled) return;
  var next = btn.getAttribute('data-ai-mode');
  if (next === aiMode()) return;
  aiSetMode(next);
  aiRenderModePills();
  toast('AI 权限已切为「' + AI_MODE_LABEL[next] + '」（仅本机生效）', 'ok');
});
$('#btn-ai-save').onclick = aiSaveSettings;
$('#btn-ai-test').onclick = aiTestConn;
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape' && !$('#ai-sessions').hidden) $('#ai-sessions').hidden = true;
});
function aiSendText() {
  var ta = $('#ai-input');
  var text = ta.value.trim();
  if (!text || aiBusy) return;
  if (!aiConfigured()) { toast('请先在设置中配置 AI 服务', 'err'); showView('set'); return; }
  ta.value = '';
  autoGrow(ta);
  aiPushEvent({ t: 'u', x: text });
  aiRunTurn();
}
function aiRenderModePills() {
  var m = aiMode();
  var pills = document.querySelectorAll('#ai-mode-pills [data-ai-mode]');
  for (var i = 0; i < pills.length; i++) {
    var pm = pills[i].getAttribute('data-ai-mode');
    pills[i].classList.toggle('on', pm === m);
    pills[i].classList.toggle('auto', pm === 'auto');
  }
}
function aiRenderSessionsPanel() {
  var p = $('#ai-sessions');
  p.innerHTML = '';
  if (!aiSessions.length) { var e = aiEl('div', 'ai-sess-empty'); e.textContent = '还没有历史会话'; p.appendChild(e); return; }
  aiSessions.forEach(function (s) {
    var it = aiEl('button', 'ai-sess-item' + (s.id === aiCurId ? ' on' : ''));
    it.type = 'button';
    var t = aiEl('span', 'ai-sess-t');
    t.textContent = s.title || '（空会话）';
    it.appendChild(t);
    var del = aiEl('span', 'ai-sess-del');
    del.textContent = '✕';
    del.title = '删除该会话';
    del.onclick = function (ev) { ev.stopPropagation(); aiDeleteSession(s.id); };
    it.appendChild(del);
    it.onclick = function () { aiSwitchSession(s.id); $('#ai-sessions').hidden = true; };
    p.appendChild(it);
  });
}
aiLoadSessions();
aiRenderModePills();
aiRenderUnconfig();
aiRenderAll();
aiLoadConf();