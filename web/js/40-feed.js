'use strict';
/* ================= 信息流：分月加载（服务端本地直读，无延迟） ================= */
var feedSeq = 0;   /* 加载代际：feedReset 后旧请求的响应作废，防止哨兵/引导交错加载把同一月份推两次 */
var justAddedPath = null;   /* 刚发布/刚保存的帖子 path：下一次渲染播一次入场动画 */
function feedReset() {
  feedSeq++;
  feed.loading = false; feed.noMore = false; feed.error = ''; feed.cursor = null;
  state.posts = [];
}
/* ================= 时间段筛选（区间 = 带边界的月份游走，零 API 改动） ================= */
function trDay(p) {   /* 帖子所属日 YYYYMMDD（stem/created 均以此开头） */
  return (p.stem || p.created || '').slice(0, 8);
}
function trPostInRange(p) {
  var r = state.timeRange;
  if (!r) return true;
  var day = trDay(p);
  if (!/^\d{8}$/.test(day)) return true;   // 无法解析时间的帖子不因筛选丢失
  if (r.from && day < r.from.replace(/-/g, '')) return false;
  if (r.to && day > r.to.replace(/-/g, '')) return false;
  return true;
}
function trFloorMonth() {   // 区间下界所在月 YYYYMM（数字），null=无下界
  var r = state.timeRange;
  return (r && r.from) ? Number(r.from.slice(0, 7).replace('-', '')) : null;
}
/* 首次加载的 before 参数：有结束月则从「结束月+1」向前游走（+1 只用于 < 比较，202612+1=202613 语义正确） */
function feedBefore() {
  if (feed.cursor !== null) return feed.cursor;
  var r = state.timeRange;
  return (r && r.to) ? String(Number(r.to.slice(0, 7).replace('-', '')) + 1) : null;
}
function timeRangeLabel() {
  var r = state.timeRange;
  if (!r) return '🕒 时间';
  var nowY = String(new Date().getFullYear());
  function fmt(d) { return d && d.slice(0, 4) === nowY ? d.slice(5) : (d || ''); }
  if (r.from && r.to) return '🕒 ' + fmt(r.from) + ' ~ ' + fmt(r.to);
  if (r.from) return '🕒 ' + fmt(r.from) + ' 起';
  return '🕒 ~ ' + fmt(r.to);
}
function setTimeRange(from, to) {   // 应用/清除时间段并重载信息流
  if (from && to && from > to) { var t = from; from = to; to = t; }   // 起止颠倒自动交换（YYYY-MM-DD 字典序=时间序）
  state.timeRange = (from || to) ? { from: from, to: to } : null;
  return initFeed().then(function () {
    if (!feed.error) settleStatus();
  });
}
function clearTimeRange() {
  if (!state.timeRange) { $('#trdlg').hidden = true; return; }
  setTimeRange(null, null).then(function () { toast('已清除时间筛选', 'ok'); });
  $('#trdlg').hidden = true;
}
function trDs(dt) { return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()); }
function trPresetList() {   // 每次打开面板现算，保证「今天/本月」等相对预设不陈旧
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  return [
    { label: '今天', from: trDs(now), to: trDs(now) },
    { label: '近7天', from: trDs(new Date(y, m, d - 6)), to: trDs(now) },
    { label: '近30天', from: trDs(new Date(y, m, d - 29)), to: trDs(now) },
    { label: '本月', from: trDs(new Date(y, m, 1)), to: trDs(now) },
    { label: '上月', from: trDs(new Date(y, m - 1, 1)), to: trDs(new Date(y, m, 0)) },
    { label: '今年', from: y + '-01-01', to: trDs(now) },
    { label: '去年', from: (y - 1) + '-01-01', to: (y - 1) + '-12-31' }
  ];
}
function renderTrPresets() {
  var box = $('#tr-presets');
  var f = $('#tr-from').value, t = $('#tr-to').value;
  box.innerHTML = '';
  trPresetList().forEach(function (ps) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (ps.from === f && ps.to === t ? ' on' : '');
    b.setAttribute('data-u32-name', 'tr-preset');
    b.textContent = ps.label;
    b.onclick = function () {   // 只回填两端输入框，可微调后再应用
      $('#tr-from').value = ps.from;
      $('#tr-to').value = ps.to;
      renderTrPresets();
    };
    box.appendChild(b);
  });
}
function openTimeDlg() {
  var r = state.timeRange;
  $('#tr-from').value = (r && r.from) || '';
  $('#tr-to').value = (r && r.to) || '';
  var today = trDs(new Date());
  $('#tr-from').max = today;
  $('#tr-to').max = today;
  $('#tr-clear').hidden = !r;
  renderTrPresets();
  $('#trdlg').hidden = false;
}
function applyTimeRange() {
  var f = $('#tr-from').value || null;
  var t = $('#tr-to').value || null;
  $('#trdlg').hidden = true;
  if (!f && !t && !state.timeRange) return;   // 两端空且原本无筛选：无需重载
  setTimeRange(f, t).then(function () {
    if (!feed.error) toast(state.timeRange ? '已按时间段筛选' : '已清除时间筛选', 'ok');
  });
}

function initFeed() {
  feedReset();
  renderAll();
  status('加载微笔记…');
  return loadNextMonth().then(function () {
    /* 倒排信息流：默认呈现最新——首批加载完贴底，视口未满时 chainMore 会继续补更早月份 */
    feedPinBottom();
  });
}
/* ================= 贴底钉扎 =================
   倒排信息流新帖贴底；用户本在底部时，任何内容高度变化（图片解码占位、同步后重载、字号调整）
   都可能把 scrollTop 钳离底部——统一约定：变化前在底部就重新钉底，保证「打开即最新」稳定成立 */
function feedAtBottom() {
  var sc = $('#feed-scroll');
  return !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
}
function feedPinBottom() {
  var sc = $('#feed-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}
function loadNextMonth() {
  /* state.ready 守卫：boot 前哨兵 IntersectionObserver 的首次触发会与本处 initFeed 交错加载同一月份 */
  if (!state.ready || feed.loading || feed.noMore) return Promise.resolve();
  feed.loading = true;
  var seq = feedSeq;
  /* 倒排信息流：更早的批次插在顶部，渲染后按高度差补偿 scrollTop，避免列表下跳 */
  var sc = $('#feed-scroll');
  var prevH = sc ? sc.scrollHeight : 0;
  var prevT = sc ? sc.scrollTop : 0;
  var hadPosts = state.posts.length > 0;
  renderSentinel();
  return apiPosts(feedBefore()).then(function (r) {
    if (seq !== feedSeq) return;   /* 期间发生过 feedReset，本响应作废 */
    if (!r.month) { feed.noMore = true; feed.loading = false; renderAll(); return; }
    var floor = trFloorMonth();
    if (floor !== null && Number(r.month) < floor) {   // 已游走出区间下界：丢弃并到此为止
      feed.noMore = true; feed.loading = false; renderAll(); return;
    }
    feed.cursor = r.month;
    var known = {};
    state.posts.forEach(function (p) { known[p.path] = 1; });
    var list = r.posts.filter(trPostInRange).sort(function (a, b) { return b.stem.localeCompare(a.stem); });
    for (var i = 0; i < list.length; i++) {
      if (!known[list[i].path]) { known[list[i].path] = 1; state.posts.push(list[i]); }
    }
    /* 钉住帖：随每次分页响应全量返回。收进 state.pinPosts（默认信息流底部「📌 钉住」区块用），
       同时并入 state.posts（筛选/时间段态按普通帖参与）；并入后按 stem 重排保住新→旧序 */
    if (r.pins && r.pins.length) {
      var pinKnown = {};
      state.pinPosts.forEach(function (p) { pinKnown[p.path] = 1; });
      r.pins.forEach(function (p) {
        if (!pinKnown[p.path]) { pinKnown[p.path] = 1; state.pinPosts.push(p); }
        if (!known[p.path]) { known[p.path] = 1; state.posts.push(p); }
      });
      state.posts.sort(function (a, b) { return b.stem.localeCompare(a.stem); });
    }
    feed.noMore = !r.more;
    feed.loading = false;
    renderAll();
    if (sc) sc.scrollTop = hadPosts ? (sc.scrollHeight - prevH + prevT) : 0;
    chainMore();
    var sb = $('#status-bar');
    if (sb.className === 'ok' && sb.textContent.indexOf('就绪') !== -1) {
      status('就绪 · ' + state.posts.length + ' 条微笔记', 'ok');
    }
  }).catch(function (e) {
    feed.loading = false;
    feed.error = e.message;
    renderAll();
    handleApiError(e);
  });
}
/* 视口未填满时继续加载（顶部哨兵实际可见才继续）。
   哨兵在 #feed 顶部：滚到底部（默认态）后 rect.top 为大负值，必须带下界判断——
   否则条件恒真会把全部历史一次性加载完；到点后再复核一次，防滚动贴底前安排的续载空跑。 */
function chainMore() {
  if (state.query || feed.loading || feed.noMore || feed.error) return;
  var r = $('#feed-sentinel').getBoundingClientRect();
  if (r.top > -60 && r.top < window.innerHeight + 400) {
    setTimeout(function () {
      if (feed.loading || feed.noMore) return;
      var rr = $('#feed-sentinel').getBoundingClientRect();
      if (rr.top > -60 && rr.top < window.innerHeight + 400) loadNextMonth();
    }, 30);
  }
}
var ioMore = new IntersectionObserver(function (entries) {
  if (state.query) return;
  if (entries.some(function (e) { return e.isIntersecting; })) loadNextMonth();
}, { rootMargin: '400px' });

/* ================= 长笔记折叠：超过 FOLD_LINES 行默认收起，可展开/收起 ================= */
var foldExpanded = {};   /* path -> true（用户已手动展开；重渲染后保持） */
function isFoldable(p) { return p.text.split('\n').length > FOLD_LINES; }
function isFolded(p) { return isFoldable(p) && !foldExpanded[p.path]; }

/* ================= 渲染 ================= */
function seenTags() {
  var used = {};
  state.posts.forEach(function (p) { p.tags.forEach(function (t) { used[t] = 1; }); });
  var ordered = state.tags.filter(function (t) { return used[t]; });
  var extras = Object.keys(used).filter(function (t) { return state.tags.indexOf(t) === -1; });
  return ordered.concat(extras);
}
function renderFilter() {
  var box = $('#filter-row');
  var tags = seenTags();
  box.innerHTML = '';
  var tb = document.createElement('button');
  tb.type = 'button';
  tb.className = 'chip' + (state.timeRange ? ' on' : '');
  tb.setAttribute('data-u32-name', 'filter-time');
  tb.title = '按时间段筛选微笔记';
  tb.textContent = timeRangeLabel();
  tb.onclick = openTimeDlg;
  box.appendChild(tb);
  var all = document.createElement('button');
  all.type = 'button';
  all.className = 'chip' + (state.filter === '' ? ' on' : '');
  all.setAttribute('data-u32-name', 'filter-all');
  all.textContent = '全部';
  all.onclick = function () { setFilter(''); };
  box.appendChild(all);
  tags.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (state.filter === t ? ' on' : '');
    b.setAttribute('data-filter-tag', t);
    b.textContent = '# ' + t;
    b.onclick = function () { setFilter(t); };
    box.appendChild(b);
  });
}
function setFilter(t) { state.filter = t; renderAll(); }
function visiblePosts() {
  var base = (state.query && state.searchHits) ? state.searchHits : state.posts;
  return base.filter(function (p) {
    if (!trPostInRange(p)) return false;   // 双保险：覆盖发布后未重载、区间单帖在界外的情况
    if (state.filter && p.tags.indexOf(state.filter) === -1) return false;
    return true;
  });
}
/* 命中词高亮：在已转义安全的文本节点上包 <mark>，不碰属性/链接 */
function highlightTerms(root, terms) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(function (node) {
    var text = node.nodeValue;
    var lower = text.toLowerCase();
    var hit = -1, term = '';
    for (var i = 0; i < terms.length; i++) {
      var idx = lower.indexOf(terms[i]);
      if (idx > -1 && (hit === -1 || idx < hit)) { hit = idx; term = terms[i]; }
    }
    if (hit === -1) return;
    var frag = document.createDocumentFragment();
    var pos = 0;
    while (hit > -1) {
      frag.appendChild(document.createTextNode(text.slice(pos, hit)));
      var mark = document.createElement('mark');
      mark.textContent = text.substr(hit, term.length);
      frag.appendChild(mark);
      pos = hit + term.length;
      var next = -1, nextTerm = '';
      var rest = text.slice(pos).toLowerCase();
      for (var j = 0; j < terms.length; j++) {
        var k = rest.indexOf(terms[j]);
        if (k > -1 && (next === -1 || k < next)) { next = k; nextTerm = terms[j]; }
      }
      if (next === -1) break;
      hit = pos + next; term = nextTerm;
    }
    frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  });
}
function searchTerms() {
  return state.query.toLowerCase().split(/\s+/).filter(Boolean);
}
function gridClass(n) { return n === 1 ? 'n1' : n === 2 ? 'n2' : n === 4 ? 'n4' : 'n3'; }

function renderFeed() {
  var box = $('#feed');
  var list = visiblePosts();
  /* 钉住区块只在默认信息流（无搜索/标签/时间段筛选）显示在最后（最新帖之下）；
     筛选/搜索态下钉住帖按普通帖参与（已并入 state.posts / searchHits） */
  var pinBlock = (!state.query && !state.filter && !state.timeRange) ? state.pinPosts : [];
  var pinMap = {};
  pinBlock.forEach(function (p) { pinMap[p.path] = 1; });
  if (!list.length && !pinBlock.length && !feed.loading && !feed.error && (state.query || feed.noMore)) {
    var why;
    if (state.query && !state.searchHits) why = '全库搜索中…';
    else if (state.query) why = '全库没有匹配「' + esc(state.query) + '」的微笔记';
    else if (state.timeRange) why = '所选时间段内没有微笔记<br><button type="button" class="tr-clear-btn" data-u32-name="tr-clear-btn">清除时间筛选</button>';
    else if (state.filter) why = '没有带「' + esc(state.filter) + '」标签的微笔记';
    else why = '还没有微笔记——在下方记录第一条吧';
    box.innerHTML = '<div class="feed-empty" data-u32-name="feed-empty">' + why + '</div>';
    return;
  }
  /* 倒排：state.posts 仍按新→旧存（API 顺序），DOM 反序输出（旧帖在上、新帖贴底），日期变化处插胶囊 */
  var out = [];
  var prevDay = '';
  for (var i = list.length - 1; i >= 0; i--) {
    var p = list[i];
    if (pinMap[p.path]) continue;   /* 默认态钉住帖只在底部区块出现，不重复进日期流 */
    var day = (p.stem || p.created || '').slice(0, 8);
    if (day !== prevDay) {
      var lbl = daySepLabel(day);
      if (lbl) out.push('<div class="daysep" data-u32-name="daysep">' + esc(lbl) + '</div>');
      prevDay = day;
    }
    out.push(state.editingPath === p.path ? editCardHtml(p) : postCardHtml(p));
  }
  if (pinBlock.length) {
    out.push('<div class="pinsep" data-u32-name="pin-sep"><span class="pin-ico">📌</span>钉住</div>');
    pinBlock.forEach(function (p) {
      out.push(state.editingPath === p.path ? editCardHtml(p) : postCardHtml(p, true));
    });
  }
  box.innerHTML = out.join('');
  if (state.query && state.searchHits) {
    var terms = searchTerms();
    var cards = box.querySelectorAll('.post');
    for (var c = 0; c < cards.length; c++) highlightTerms(cards[c], terms);
  }
  justAddedPath = null;   /* 入场动画只播一次，重渲染（筛选/搜索）不重播 */
}

function postCardHtml(p, isPinned) {
  var h = '<article class="post' + (isPinned ? ' pinned' : '') + (p.path === justAddedPath ? ' post-in' : '') + '" data-path="' + esc(p.path) + '" data-u32-name="post">'
    + '<div class="post-rail" data-u32-name="post-rail"><span class="post-node" data-u32-name="post-node"></span></div>'
    + '<div class="post-main" data-u32-name="post-main">'
    + '<div class="post-head" data-u32-name="post-head"><span class="ptime" title="' + esc(postTimeFull(p)) + '">' + esc(postTime(p)) + '</span>';
    /* 标签紧跟时间靠左；动作按钮推最右 */
    if (p.tags.length) {
      var isTodo = p.tags.indexOf(TODO_TAG) > -1 || p.tags.indexOf(DONE_TODO) > -1;
      h += '<span class="ptags" data-u32-name="post-tags">'
        + (isTodo ? '<label class="todo-check' + (p.tags.indexOf(DONE_TODO) > -1 ? ' done' : '') + '" data-u32-name="todo-check" title="勾选标记待办完成"><input type="checkbox" class="todo-check-input" data-u32-name="todo-check-input"' + (p.tags.indexOf(DONE_TODO) > -1 ? ' checked' : '') + ' aria-label="待办完成"><span>待办</span></label>' : '')
        + p.tags.map(function (t) {
        return '<span class="ptag"># ' + esc(t) + '</span>';
      }).join('') + '</span>';
    }
    h += '<span class="pacts" data-u32-name="post-actions">'
      + '<button type="button" class="act-pin' + (isPinned ? ' on' : '') + '" data-u32-name="act-pin" title="' + (isPinned ? '取钉（不再钉在最新下方）' : '钉住（始终显示在最新下方）') + '" aria-label="钉住"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6"/><path d="M12 4v6"/><path d="M8 10h8l1.5 4h-11L8 10Z"/><path d="M12 14v6"/></svg></button>'
      + '<button type="button" class="act-edit" data-u32-name="act-edit" title="编辑" aria-label="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>'
      + '<button type="button" class="act-del" data-u32-name="act-del" title="删除" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>'
      + '</span></div>';
  if (p.text) {
    var folded = isFolded(p);
    h += '<div class="ptext' + (folded ? ' folded' : '') + '" data-u32-name="post-text">' + textHtml(p.text) + '</div>';
    if (isFoldable(p)) {
      h += '<button type="button" class="fold-toggle" data-u32-name="fold-toggle">' + (folded ? '展开 ▾' : '收起 ▴') + '</button>';
    }
  }
  if (p.images.length) {
    h += '<div class="pgrid ' + gridClass(p.images.length) + '" data-u32-name="post-grid">'
      + p.images.map(function (nm, idx) {
        return '<img class="gimg" alt="' + esc(nm) + '" loading="lazy" src="' + mediaUrl(p.dir, nm) + '" data-idx="' + idx + '">';
      }).join('') + '</div>';
  }
  var pfs = p.files || [];
  if (pfs.length) {
    h += '<div class="plist" data-u32-name="post-files">'
      + pfs.map(function (f) {
        return '<a class="pfile" href="' + mediaUrl(p.dir, f.path) + '" download="' + esc(f.path) + '" title="下载附件 ' + esc(f.name) + '" data-u32-name="post-file">'
          + '<span>📄</span><span class="pf-name">' + esc(f.name) + '</span></a>';
      }).join('') + '</div>';
  }
  return h + '</div></article>';
}

function editCardHtml(p) {
  var h = '<article class="post" data-path="' + esc(p.path) + '" data-u32-name="post-editing">'
    + '<div class="post-rail" data-u32-name="post-rail"><span class="post-node" data-u32-name="post-node"></span></div>'
    + '<div class="post-main" data-u32-name="post-main">'
    + '<div class="post-head" data-u32-name="post-head"><span class="ptime">编辑中…</span></div>'
    + '<div id="edit-box" class="edit-box" data-u32-name="edit-box">'
    + '<textarea id="edit-text" data-u32-name="edit-text" spellcheck="false"></textarea>'
    + '<div id="edit-tags" class="chips" data-u32-name="edit-tags"></div>'
    + '<div id="edit-imgs" class="strip" data-u32-name="edit-imgs" hidden></div>'
    + '<span id="edit-count" class="img-count" data-u32-name="edit-count" hidden></span>'
    + '<div id="edit-files" class="strip" data-u32-name="edit-files" hidden></div>'
    + '<span id="edit-file-count" class="img-count" data-u32-name="edit-file-count" hidden></span>'
    + '<div class="edit-actions" data-u32-name="edit-actions">'
    + '<button type="button" id="btn-edit-img" data-u32-name="btn-edit-img" title="添加图片；也可粘贴或拖拽进正文框">📷 图片</button>'
    + '<input id="edit-img-file" type="file" accept="image/*" multiple hidden data-u32-name="edit-img-file">'
    + '<button type="button" id="btn-edit-file" data-u32-name="btn-edit-file" title="添加附件（任意文件，单个 ≤10MB，最多 9 个）">📎 附件</button>'
    + '<input id="edit-file-file" type="file" multiple hidden data-u32-name="edit-file-file">'
    + '<button type="button" id="btn-edit-cancel" data-u32-name="btn-edit-cancel">取消</button>'
    + '<button type="button" id="btn-edit-save" class="primary" data-u32-name="btn-edit-save">保 存</button>'
    + '</div></div></div></article>';
  return h;
}
function mountEditCard() {
  var c = editCtx;
  if (!c) return;
  var ta = $('#edit-text');
  if (!ta) return;
  ta.value = c.text;
  renderChips($('#edit-tags'), c.selTags, true, onEditTag, addEditCustomTag);
  renderEditStrip();
  renderEditFiles();
  bindEditEvents();
}
/* 编辑态缩略条：保留图（本地 /media 直出）+ 新增图（dataURL） */
function renderEditStrip() {
  var c = editCtx;
  var box = $('#edit-imgs');
  if (!box) return;
  box.innerHTML = '';
  c.keepNames.forEach(function (nm) {
    var d = document.createElement('div');
    d.className = 'thumb'; d.setAttribute('data-u32-name', 'thumb-keep'); d.title = nm;
    var im = document.createElement('img');
    im.src = mediaUrl(c.dir, nm);
    im.alt = nm;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb-del'; b.textContent = '✕'; b.title = '删除这张图';
    b.onclick = function () {
      c.keepNames = c.keepNames.filter(function (x) { return x !== nm; });
      c.removedNames.push(nm);
      renderEditStrip();
    };
    d.appendChild(im); d.appendChild(b); box.appendChild(d);
  });
  c.newImgs.forEach(function (im) {
    var d = document.createElement('div');
    d.className = 'thumb'; d.setAttribute('data-u32-name', 'thumb-new'); d.title = '新图 ' + im.kb + 'KB';
    var img = document.createElement('img');
    img.src = 'data:' + im.mime + ';base64,' + im.base64; img.alt = '';
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb-del'; b.textContent = '✕'; b.title = '移除';
    b.onclick = function () {
      c.newImgs = c.newImgs.filter(function (x) { return x.id !== im.id; });
      renderEditStrip();
    };
    d.appendChild(img); d.appendChild(b); box.appendChild(d);
  });
  box.hidden = !(c.keepNames.length + c.newImgs.length);
  var cnt = $('#edit-count');
  if (cnt) {
    var n = c.keepNames.length + c.newImgs.length;
    cnt.hidden = !n;
    cnt.textContent = n ? n + '/' + MAX_IMAGES + ' 张图' : '';
  }
}

function renderSentinel() {
  var el = $('#feed-sentinel');
  el.innerHTML = '';
  if (state.query) return;   /* 全库搜索态：无分页概念 */
  if (feed.error) {
    var b = document.createElement('button');
    b.textContent = '⚠ 加载失败：' + feed.error + '（点击重试）';
    b.setAttribute('data-u32-name', 'feed-retry');
    b.onclick = function () { feed.error = ''; loadNextMonth(); };
    el.appendChild(b);
    return;
  }
  if (feed.loading) { el.textContent = '加载更早的微笔记…'; return; }
  if (feed.noMore) {
    el.textContent = state.posts.length
      ? (state.timeRange ? '— 已到筛选时间段起点 —' : '— 已到最早 —')
      : '';
    return;
  }
  el.textContent = '▲ 上滑加载更早';
}
function renderSearchMeta() {
  var el = $('#search-meta');
  if (!state.query) { el.hidden = true; return; }
  el.hidden = false;
  if (!state.searchHits) { el.textContent = '全库搜索中…'; return; }
  el.textContent = '全库命中 ' + state.searchHits.length + ' 条（' + state.searchMs + ' ms）· 信息流已加载 ' + state.posts.length + ' 条';
}
function renderAll() {
  var wasBottom = feedAtBottom();   /* 重渲染（同步合并/筛选/编辑）前在底部就保持钉底 */
  renderFilter();
  renderSearchMeta();
  renderFeed();
  renderSentinel();
  if (editCtx) mountEditCard();
  if (wasBottom) feedPinBottom();
}

/* ================= 全库搜索（服务端扫本地仓库，支持拼音/首字母） ================= */
var searchTimer = null;
var searchSeq = 0;
function runSearch(q) {
  var seq = ++searchSeq;
  state.query = q;
  state.searchHits = null;
  renderAll();
  if (!q) return Promise.resolve();
  return apiSearch(q).then(function (r) {
    if (seq !== searchSeq) return;   /* 已有更新一次搜索发起，丢弃旧结果 */
    state.searchHits = r.hits;
    state.searchMs = r.ms;
    renderAll();
  }).catch(handleApiError);
}
