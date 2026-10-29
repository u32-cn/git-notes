'use strict';
/* ================= 发布 ================= */
var capImages = [];   /* {id, mime, ext, base64, kb} */
var capImgSeq = 0;
var CAP_IMG_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif' };
var capFiles = [];    /* {id, name, ext, base64, kb} 任意附件 */

/* 从文件名取扩展名（服务端同样校验 [a-z0-9]{1,12}）；无扩展名拒绝 */
function extOfFileName(name) {
  var m = /\.([A-Za-z0-9]{1,12})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
function fmtKb(size) { return Math.max(1, Math.round(size / 1024)) + 'KB'; }

function renderCapFileStrip() {
  var box = $('#cap-files');
  box.innerHTML = '';
  capFiles.forEach(function (f) {
    var d = document.createElement('div');
    d.className = 'file-chip'; d.setAttribute('data-u32-name', 'cap-file-chip'); d.title = f.name + '（' + f.kb + '）';
    var icon = document.createElement('span'); icon.textContent = '📄';
    var nm = document.createElement('span'); nm.className = 'fc-name'; nm.textContent = f.name;
    var sz = document.createElement('span'); sz.textContent = f.kb;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb-del'; b.textContent = '✕'; b.title = '移除';
    b.onclick = function () {
      capFiles = capFiles.filter(function (x) { return x.id !== f.id; });
      renderCapFileStrip();
    };
    d.appendChild(icon); d.appendChild(nm); d.appendChild(sz); d.appendChild(b); box.appendChild(d);
  });
  box.hidden = !capFiles.length;
  var fc = $('#cap-file-count');
  if (fc) {
    fc.hidden = !capFiles.length;
    fc.textContent = capFiles.length ? capFiles.length + '/' + MAX_FILES + ' 个附件' : '';
  }
}
function stageCapFile(file) {
  var ext = extOfFileName(file && file.name);
  if (!ext) { toast('错误：附件必须有扩展名（' + (file && file.name) + '）', 'err'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('错误：附件超过 10MB（' + file.name + '）', 'err'); return; }
  if (capFiles.length >= MAX_FILES) { toast('错误：最多 ' + MAX_FILES + ' 个附件', 'err'); return; }
  var fr = new FileReader();
  fr.onload = function () {
    var dataUrl = String(fr.result);
    capFiles.push({
      id: 'file' + Date.now().toString(36) + '-' + (++capImgSeq),
      name: file.name, ext: ext,
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      kb: fmtKb(file.size)
    });
    renderCapFileStrip();
  };
  fr.onerror = function () { toast('错误：附件读取失败（' + file.name + '）', 'err'); };
  fr.readAsDataURL(file);
}

function renderCapStrip() {
  var box = $('#cap-imgs');
  box.innerHTML = '';
  capImages.forEach(function (im) {
    var d = document.createElement('div');
    d.className = 'thumb'; d.setAttribute('data-u32-name', 'cap-thumb'); d.title = im.kb + 'KB';
    var img = document.createElement('img');
    img.src = 'data:' + im.mime + ';base64,' + im.base64; img.alt = '';
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb-del'; b.textContent = '✕'; b.title = '移除';
    b.onclick = function () {
      capImages = capImages.filter(function (x) { return x.id !== im.id; });
      renderCapStrip();
    };
    d.appendChild(img); d.appendChild(b); box.appendChild(d);
  });
  box.hidden = !capImages.length;
  var cc = $('#cap-count');
  if (cc) {
    cc.hidden = !capImages.length;
    cc.textContent = capImages.length ? capImages.length + '/' + MAX_IMAGES + ' 张图' : '';
  }
}
function stageCapImage(file) {
  var mime = (file && file.type) || '';
  if (!CAP_IMG_MIME[mime]) { toast('错误：仅支持图片（png/jpg/webp/gif/bmp/avif）', 'err'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('错误：图片超过 10MB（' + file.name + '）', 'err'); return; }
  if (capImages.length >= MAX_IMAGES) { toast('错误：最多 ' + MAX_IMAGES + ' 张图', 'err'); return; }
  var fr = new FileReader();
  fr.onload = function () {
    var dataUrl = String(fr.result);
    capImages.push({
      id: 'img' + Date.now().toString(36) + '-' + (++capImgSeq),
      mime: mime, ext: CAP_IMG_MIME[mime],
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      kb: Math.max(1, Math.round(file.size / 1024))
    });
    renderCapStrip();
  };
  fr.onerror = function () { toast('错误：图片读取失败（' + file.name + '）', 'err'); };
  fr.readAsDataURL(file);
}

var publishing = false;
/* 移动端发布器折叠/展开（.composer.open 由 CSS 控制；宽屏类不存在无副作用） */
function collapseCompose() { var c = $('#composer'); if (c) c.classList.remove('open'); }
function expandCompose() {
  var c = $('#composer');
  if (!c) return;
  c.classList.add('open');
  $('#cap-input').focus();
}
/* Ctrl+Enter 提示仅在有键盘的宽屏 placeholder 中出现（移动端无键盘） */
function updateComposePlaceholder() {
  $('#cap-input').placeholder = wideMq.matches ? '记录这一刻…（Ctrl+Enter 发布）' : '记录这一刻…';
}
function publish() {
  if (publishing) return;
  if (!state.ready) { toast('错误：尚未完成首次配置', 'err'); return; }
  var text = $('#cap-input').value.replace(/\s+$/, '');
  var imgs = capImages.slice();
  var fls = capFiles.slice();
  if (!text.trim() && !imgs.length && !fls.length) { toast('错误：内容为空', 'err'); return; }
  publishing = true;
  var btn = $('#btn-publish');
  btn.disabled = true;
  btn.textContent = '发布中…';
  status(fls.length ? '发布中（含 ' + fls.length + ' 个附件）…' : imgs.length ? '发布中（含 ' + imgs.length + ' 张图片）…' : '发布中…');
  apiCreatePost({
    text: text,
    tags: capSel.slice(),
    images: imgs.map(function (im) { return { ext: im.ext, base64: im.base64 }; }),
    files: fls.map(function (f) { return { name: f.name, ext: f.ext, base64: f.base64 }; })
  }).then(function (post) {
    state.posts.unshift(post);
    justAddedPath = post.path;
    capImages = [];
    capFiles = [];
    capSel = [];
    $('#cap-input').value = '';
    autoGrow($('#cap-input'));
    if (state.filter && post.tags.indexOf(state.filter) === -1) state.filter = '';
    renderAll();
    renderCapStrip();
    renderCapFileStrip();
    renderCapChips();
    collapseCompose();
    /* 倒排信息流：新帖贴底，发布后滚到最新 */
    var sc = $('#feed-scroll');
    if (sc) sc.scrollTop = sc.scrollHeight;
    toast(state.timeRange && !trPostInRange(post) ? '已发布（不在当前时间段筛选内）' : '已发布', 'ok');
    settleStatus();
    refreshSyncStatus();
  }).catch(handleApiError).finally(function () {
    publishing = false;
    btn.disabled = false;
    btn.textContent = '发 布';
  });
}

/* ================= 编辑 ================= */
function postByPath(p) {
  for (var i = 0; i < state.posts.length; i++) if (state.posts[i].path === p) return state.posts[i];
  return null;
}
function startEdit(path) {
  var p = postByPath(path);
  if (!p) return;
  editCtx = {
    path: p.path, dir: p.dir, stem: p.stem,
    text: p.text, selTags: p.tags.slice(),
    keepNames: p.images.slice(), removedNames: [], newImgs: [],
    files: (p.files || []).slice(),
    keepFilePaths: (p.files || []).map(function (f) { return f.path; }),
    newFiles: [],
    created: p.created
  };
  state.editingPath = path;
  renderAll();
  var ta = $('#edit-text');
  if (ta) ta.focus();
}
function cancelEdit() {
  editCtx = null;
  state.editingPath = null;
  renderAll();
}
var editSaving = false;
/* 待办复选框：勾选=「待办」→「已完成待办」，取消=反向；走 PUT /api/posts 整帖更新（commit 规范同编辑） */
var todoBusy = {};
function toggleTodo(path, checked) {
  if (todoBusy[path]) return;
  var p = postByPath(path);
  if (!p) return;
  var target = checked ? DONE_TODO : TODO_TAG;
  var other = checked ? TODO_TAG : DONE_TODO;
  var tags = p.tags.map(function (t) { return t === other ? target : t; });
  if (tags.indexOf(target) === -1) tags.push(target);
  todoBusy[path] = true;
  status('更新中…');
  apiUpdatePost({ path: path, text: p.text, tags: tags })
    .then(function (post) {
      p.tags = post.tags; p.text = post.text; p.images = post.images; p.files = post.files || [];
      renderAll();
      toast(checked ? '待办已完成' : '已恢复待办', 'ok');
      settleStatus();
      refreshSyncStatus();
    })
    .catch(function (e) { renderAll(); handleApiError(e); })
    .finally(function () { todoBusy[path] = false; });
}
/* 钉住/取钉：POST /api/posts/pin（settings/main.json 的 pins），成功后就地更新 pinPosts 并重渲染 */
var pinBusy = {};
function togglePin(path) {
  if (pinBusy[path]) return;
  var idx = -1;
  for (var i = 0; i < state.pinPosts.length; i++) { if (state.pinPosts[i].path === path) { idx = i; break; } }
  var toPin = idx === -1;
  if (toPin) {
    var p = postByPath(path);
    if (!p) return;
    if (state.pinPosts.length >= 9) { toast('最多钉住 9 篇笔记', 'err'); return; }
  }
  pinBusy[path] = true;
  apiPin(path, toPin)
    .then(function (pins) {
      if (toPin) state.pinPosts.push(p);
      else state.pinPosts.splice(idx, 1);
      renderAll();
      toast(toPin ? '已钉住（显示在最新下方）' : '已取钉', 'ok');
      refreshSyncStatus();
    })
    .catch(handleApiError)
    .finally(function () { pinBusy[path] = false; });
}
function saveEdit() {
  if (!editCtx || editSaving) return;
  var c = editCtx;
  var ta = $('#edit-text');
  var text = (ta ? ta.value : c.text).replace(/\s+$/, '');
  var total = c.keepNames.length + c.newImgs.length;
  var totalF = c.keepFilePaths.length + c.newFiles.length;
  if (!text.trim() && !total && !totalF) { toast('错误：内容为空', 'err'); return; }
  if (total > MAX_IMAGES) { toast('错误：最多 ' + MAX_IMAGES + ' 张图', 'err'); return; }
  if (totalF > MAX_FILES) { toast('错误：最多 ' + MAX_FILES + ' 个附件', 'err'); return; }
  editSaving = true;
  var btn = $('#btn-edit-save');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  status('保存中…');
  apiUpdatePost({
    path: c.path,
    text: text,
    tags: c.selTags.slice(),
    keepNames: c.keepNames.slice(),
    newImages: c.newImgs.map(function (im) { return { ext: im.ext, base64: im.base64 }; }),
    keepFileNames: c.keepFilePaths.slice(),
    newFiles: c.newFiles.map(function (f) { return { name: f.name, ext: f.ext, base64: f.base64 }; })
  }).then(function (post) {
    var p = postByPath(c.path);
    if (p) { p.text = post.text; p.tags = post.tags; p.images = post.images; p.files = post.files || []; }
    editCtx = null;
    state.editingPath = null;
    justAddedPath = c.path;
    renderAll();
    toast('已保存（git 历史可找回）', 'ok');
    settleStatus();
    refreshSyncStatus();
  }).catch(handleApiError).finally(function () {
    editSaving = false;
    if (btn) { btn.disabled = false; btn.textContent = '保 存'; }
  });
}
function stageEditImage(file) {
  if (!editCtx) return;
  var mime = (file && file.type) || '';
  if (!CAP_IMG_MIME[mime]) { toast('错误：仅支持图片（png/jpg/webp/gif/bmp/avif）', 'err'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('错误：图片超过 10MB（' + file.name + '）', 'err'); return; }
  if (editCtx.keepNames.length + editCtx.newImgs.length >= MAX_IMAGES) { toast('错误：最多 ' + MAX_IMAGES + ' 张图', 'err'); return; }
  var fr = new FileReader();
  fr.onload = function () {
    var dataUrl = String(fr.result);
    editCtx.newImgs.push({
      id: 'img' + Date.now().toString(36) + '-' + (++capImgSeq),
      mime: mime, ext: CAP_IMG_MIME[mime],
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      kb: Math.max(1, Math.round(file.size / 1024))
    });
    renderEditStrip();
  };
  fr.onerror = function () { toast('错误：图片读取失败（' + file.name + '）', 'err'); };
  fr.readAsDataURL(file);
}
function stageEditFile(file) {
  if (!editCtx) return;
  var ext = extOfFileName(file && file.name);
  if (!ext) { toast('错误：附件必须有扩展名（' + (file && file.name) + '）', 'err'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('错误：附件超过 10MB（' + file.name + '）', 'err'); return; }
  if (editCtx.keepFilePaths.length + editCtx.newFiles.length >= MAX_FILES) { toast('错误：最多 ' + MAX_FILES + ' 个附件', 'err'); return; }
  var fr = new FileReader();
  fr.onload = function () {
    var dataUrl = String(fr.result);
    editCtx.newFiles.push({
      id: 'file' + Date.now().toString(36) + '-' + (++capImgSeq),
      name: file.name, ext: ext,
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      kb: fmtKb(file.size)
    });
    renderEditFiles();
  };
  fr.onerror = function () { toast('错误：附件读取失败（' + file.name + '）', 'err'); };
  fr.readAsDataURL(file);
}
/* 编辑态附件条：保留附件（原始名+磁盘路径）+ 新增附件 */
function renderEditFiles() {
  var c = editCtx;
  var box = $('#edit-files');
  if (!box) return;
  box.innerHTML = '';
  c.files.forEach(function (f) {
    var kept = c.keepFilePaths.indexOf(f.path) > -1;
    var d = document.createElement('div');
    d.className = 'file-chip'; d.setAttribute('data-u32-name', 'edit-file-keep'); d.title = f.name;
    if (!kept) d.style.opacity = '0.45';
    var icon = document.createElement('span'); icon.textContent = '📄';
    var nm = document.createElement('span'); nm.className = 'fc-name'; nm.textContent = f.name;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb-del'; b.textContent = kept ? '✕' : '↺';
    b.title = kept ? '删除这个附件' : '恢复这个附件';
    b.onclick = function () {
      if (kept) c.keepFilePaths = c.keepFilePaths.filter(function (x) { return x !== f.path; });
      else c.keepFilePaths.push(f.path);
      renderEditFiles();
    };
    d.appendChild(icon); d.appendChild(nm); d.appendChild(b); box.appendChild(d);
  });
  c.newFiles.forEach(function (f) {
    var d = document.createElement('div');
    d.className = 'file-chip'; d.setAttribute('data-u32-name', 'edit-file-new'); d.title = '新附件 ' + f.name + '（' + f.kb + '）';
    var icon = document.createElement('span'); icon.textContent = '📄';
    var nm = document.createElement('span'); nm.className = 'fc-name'; nm.textContent = f.name;
    var sz = document.createElement('span'); sz.textContent = f.kb;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb-del'; b.textContent = '✕'; b.title = '移除';
    b.onclick = function () {
      c.newFiles = c.newFiles.filter(function (x) { return x.id !== f.id; });
      renderEditFiles();
    };
    d.appendChild(icon); d.appendChild(nm); d.appendChild(sz); d.appendChild(b); box.appendChild(d);
  });
  box.hidden = !(c.files.length + c.newFiles.length);
  var fc = $('#edit-file-count');
  if (fc) {
    var fn = c.keepFilePaths.length + c.newFiles.length;
    fc.hidden = !(c.files.length + c.newFiles.length);
    fc.textContent = fn ? fn + '/' + MAX_FILES + ' 个附件' : '';
  }
}
/* 编辑卡事件（卡片每次重渲染后重新绑定） */
function bindEditEvents() {
  var ta = $('#edit-text');
  var btnImg = $('#btn-edit-img');
  var fileIn = $('#edit-img-file');
  var btnFile = $('#btn-edit-file');
  var fileInF = $('#edit-file-file');
  var btnSave = $('#btn-edit-save');
  var btnCancel = $('#btn-edit-cancel');
  if (!ta) return;
  btnImg.onclick = function () { fileIn.click(); };
  fileIn.onchange = function () {
    var fs = Array.prototype.slice.call(this.files || []);
    fs.forEach(stageEditImage);
    this.value = '';
  };
  btnFile.onclick = function () { fileInF.click(); };
  fileInF.onchange = function () {
    var fs = Array.prototype.slice.call(this.files || []);
    fs.forEach(stageEditFile);
    this.value = '';
  };
  btnSave.onclick = saveEdit;
  btnCancel.onclick = cancelEdit;
  ta.addEventListener('paste', function (e) {
    var files = filesFromClipboard(e);
    if (!files.length) return;
    e.preventDefault();
    files.forEach(stageEditImage);
  });
  ta.addEventListener('dragover', function (e) { e.preventDefault(); var b = $('#edit-box'); if (b) b.classList.add('drag'); });
  ta.addEventListener('drop', function (e) {
    e.preventDefault();
    var b = $('#edit-box');
    if (b) b.classList.remove('drag');
    var files = Array.prototype.slice.call(e.dataTransfer && e.dataTransfer.files || []).filter(function (f) { return /^image\//.test(f.type); });
    files.forEach(stageEditImage);
  });
}

/* ================= 删除 ================= */
function deletePost(path) {
  var p = postByPath(path);
  if (!p) return;
  dlg('删除微笔记', { text: '确定删除 ' + postTimeFull(p) + ' 的这条微笔记？配图与附件一并删除，git 历史中可找回。', ok: '删除', danger: true })
    .then(function (yes) {
      if (!yes) return;
      status('删除中…');
      apiDeletePost(path).then(function () {
        state.posts = state.posts.filter(function (x) { return x.path !== path; });
        renderAll();
        toast('已删除（git 历史可找回）', 'ok');
        settleStatus();
        refreshSyncStatus();
      }).catch(handleApiError);
    });
}
