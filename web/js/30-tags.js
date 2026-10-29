'use strict';
/* ================= 标签（清单存 git：settings/tags.json） ================= */
function cleanTag(s) {
  return (s || '').trim().replace(/[\[\]",{}]/g, '').replace(/\s+/g, ' ').slice(0, 16);
}
var capSel = [];   /* 发布器已选标签（选择顺序） */
function renderChips(box, sel, withAdd, ontoggle, onadd) {
  box.innerHTML = '';
  state.tags.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (sel.indexOf(t) > -1 ? ' on' : '');
    b.setAttribute('data-tag', t);
    b.textContent = t;
    b.onclick = function () { ontoggle(t); };
    box.appendChild(b);
  });
  if (withAdd) {
    var a = document.createElement('button');
    a.type = 'button';
    a.className = 'chip add';
    a.setAttribute('data-u32-name', 'chip-add');
    a.textContent = '＋ 标签';
    a.onclick = onadd;
    box.appendChild(a);
  }
}
function toggleArr(arr, t) {
  var i = arr.indexOf(t);
  if (i > -1) arr.splice(i, 1); else arr.push(t);
}
function renderCapChips() { renderChips($('#cap-tags'), capSel, true, onCapTag, addCustomTag); }
function onCapTag(t) { toggleArr(capSel, t); renderCapChips(); }
/* 存量清单迁移：补入后加的默认标签（action add 基于磁盘现状合并，多端安全）。
   「已完成待办」为待办语义始终补入；「想法/感悟」一次性补入（localStorage 记忆，
   用户主动移除后不再回加）。标签加载成功后调用。 */
var MIGRATE_TAGS = ['想法', '感悟'];
function ensureDefaultTags() {
  var missing = [];
  if (state.tags.indexOf(DONE_TODO) === -1) missing.push(DONE_TODO);
  var migrated = {};
  try { migrated = JSON.parse(localStorage.getItem('gnTagMigrate2') || '{}'); } catch (_) { migrated = {}; }
  MIGRATE_TAGS.forEach(function (t) {
    if (state.tags.indexOf(t) === -1 && !migrated[t]) missing.push(t);
  });
  if (!missing.length) return Promise.resolve();
  var i = 0;
  function next() {
    if (i >= missing.length) return Promise.resolve();
    var t = missing[i++];
    return apiSaveTags(state.tags, 'add', t).then(function (list) {
      state.tags = list;
      try { migrated[t] = 1; localStorage.setItem('gnTagMigrate2', JSON.stringify(migrated)); } catch (_) {}
      renderCapChips();
      renderFilter();
      return next();
    });
  }
  return next().catch(function () {});   /* 失败静默：下次加载重试 */
}
function loadTags() {
  return apiGetTags().then(function (r) {
    if (Array.isArray(r.tags) && r.tags.length) state.tags = r.tags;
    return ensureDefaultTags().then(function () {
      renderCapChips();
      renderFilter();
    });
  }).catch(function (e) {
    state.tags = DEFAULT_TAGS.slice();   /* 读取失败兜底：暂用默认清单 */
    toast('标签清单读取失败，暂用默认：' + e.message, 'err');
  });
}
/* 新增标签：乐观更新 → 服务端基于最新清单合并写入，失败回滚（采纳服务端返回清单） */
function addTagGlobal(name, done) {
  var t = cleanTag(name);
  if (!t) return;
  if (state.tags.indexOf(t) > -1) { if (done) done(t); return; }
  state.tags.push(t);
  apiSaveTags(state.tags, 'add', t).then(function (list) {
    state.tags = list;
    if (done) done(t);
    toast('已添加标签 ' + t, 'ok');
    renderCapChips();
    renderFilter();
    refreshSyncStatus();
  }).catch(function (e) {
    state.tags = state.tags.filter(function (x) { return x !== t; });
    handleApiError(e);
  });
}
function removeTagGlobal(t) {
  state.tags = state.tags.filter(function (x) { return x !== t; });
  apiSaveTags(state.tags, 'remove', t).then(function (list) {
    state.tags = list;
    capSel = capSel.filter(function (x) { return x !== t; });
    if (editCtx) editCtx.selTags = editCtx.selTags.filter(function (x) { return x !== t; });
    renderSettingsTags();
    renderCapChips();
    renderFilter();
    toast('已移除标签 ' + t, 'ok');
    refreshSyncStatus();
  }).catch(function (e) {
    state.tags.push(t);
    handleApiError(e);
  });
}
function addCustomTag() {
  dlg('自定义标签', { input: '标签名（≤16 字，写入仓库标签清单）', ok: '添加' }).then(function (v) {
    if (!cleanTag(v)) return;
    addTagGlobal(v, function (t) {
      if (capSel.indexOf(t) === -1) capSel.push(t);
      renderCapChips();
    });
  });
}
function onEditTag(t) {
  if (!editCtx) return;
  toggleArr(editCtx.selTags, t);
  renderChips($('#edit-tags'), editCtx.selTags, true, onEditTag, addEditCustomTag);
}
function addEditCustomTag() {
  if (!editCtx) return;
  dlg('自定义标签', { input: '标签名（≤16 字，写入仓库标签清单）', ok: '添加' }).then(function (v) {
    if (!cleanTag(v)) return;
    addTagGlobal(v, function (t) {
      if (editCtx.selTags.indexOf(t) === -1) editCtx.selTags.push(t);
      renderChips($('#edit-tags'), editCtx.selTags, true, onEditTag, addEditCustomTag);
    });
  });
}
/* 设置页：标签管理 */
function renderSettingsTags() {
  var box = $('#settings-tags');
  box.innerHTML = '';
  state.tags.forEach(function (t) {
    var s = document.createElement('span');
    s.className = 'chip tag-mgmt';
    s.setAttribute('data-u32-name', 'settings-tag');
    var txt = document.createElement('span');
    txt.textContent = t;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag-del';
    b.setAttribute('data-u32-name', 'settings-tag-del');
    b.textContent = '✕';
    b.title = '移除标签';
    b.onclick = function () { removeTagGlobal(t); };
    s.appendChild(txt);
    s.appendChild(b);
    box.appendChild(s);
  });
}
