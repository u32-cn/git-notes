'use strict';
/* ================= 事件绑定（CSP：禁 inline handler，全部 addEventListener） ================= */
$('#btn-publish').onclick = publish;
$('#btn-cap-img').onclick = function () { $('#cap-img-file').click(); };
$('#btn-cap-file').onclick = function () { $('#cap-file-file').click(); };
$('#cap-img-file').addEventListener('change', function () {
  Array.prototype.slice.call(this.files || []).forEach(stageCapImage);
  this.value = '';
});
$('#cap-file-file').addEventListener('change', function () {
  Array.prototype.slice.call(this.files || []).forEach(stageCapFile);
  this.value = '';
});
$('#cap-input').addEventListener('input', function () { autoGrow(this); });
$('#cap-input').addEventListener('keydown', function (ev) {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); publish(); }
});
$('#cap-input').addEventListener('paste', function (e) {
  var files = filesFromClipboard(e);
  if (!files.length) return;
  e.preventDefault();
  files.forEach(stageCapImage);
});
$('#cap-input').addEventListener('dragover', function (e) { e.preventDefault(); $('#composer').classList.add('drag'); });
$('#cap-input').addEventListener('dragleave', function () { $('#composer').classList.remove('drag'); });
$('#cap-input').addEventListener('drop', function (e) {
  e.preventDefault();
  $('#composer').classList.remove('drag');
  Array.prototype.slice.call(e.dataTransfer && e.dataTransfer.files || [])
    .filter(function (f) { return /^image\//.test(f.type); })
    .forEach(stageCapImage);
});

/* 信息流卡片：事件委托 */
$('#feed').addEventListener('click', function (ev) {
  var t = ev.target;
  if (!(t && t.closest)) return;
  var trClr = t.closest('.tr-clear-btn');
  if (trClr) { clearTimeRange(); return; }
  var foldBtn = t.closest('.fold-toggle');
  if (foldBtn) {
    /* 长笔记展开/收起：就地切类不重渲染，重渲染后按 foldExpanded 保持状态 */
    var fcard = foldBtn.closest('.post');
    if (!fcard) return;
    var fpath = fcard.getAttribute('data-path');
    var pt = fcard.querySelector('.ptext');
    if (!pt) return;
    var nowFolded = pt.classList.toggle('folded');
    foldExpanded[fpath] = !nowFolded;
    foldBtn.textContent = nowFolded ? '展开 ▾' : '收起 ▴';
    return;
  }
  var editBtn = t.closest('.act-edit');
  if (editBtn) {
    var card = editBtn.closest('.post');
    if (card) startEdit(card.getAttribute('data-path'));
    return;
  }
  var pinBtn = t.closest('.act-pin');
  if (pinBtn) {
    var pcard = pinBtn.closest('.post');
    if (pcard) togglePin(pcard.getAttribute('data-path'));
    return;
  }
  var delBtn = t.closest('.act-del');
  if (delBtn) {
    var card2 = delBtn.closest('.post');
    if (card2) deletePost(card2.getAttribute('data-path'));
    return;
  }
  var gimg = t.closest('img.gimg');
  if (gimg) {
    var card3 = gimg.closest('.post');
    var p = postByPath(card3.getAttribute('data-path'));
    if (p) openLb(p, Number(gimg.getAttribute('data-idx')) || 0);
  }
});

/* 正文链接右键直接复制（contextmenu 属用户手势，clipboard.writeText 放行，同灯箱右键菜单机制）；
   只接管 .ptext 内的 http(s) 链接，其余区域保留浏览器默认菜单。移动端长按链接走系统原生菜单不受影响 */
$('#feed').addEventListener('contextmenu', function (ev) {
  var t = ev.target;
  var a = (t && t.closest) ? t.closest('.ptext a') : null;
  if (!a) return;
  ev.preventDefault();
  var href = a.getAttribute('href') || '';
  if (!href) return;
  if (!(navigator.clipboard && navigator.clipboard.writeText)) { toast('当前环境不支持复制链接', 'err'); return; }
  navigator.clipboard.writeText(href).then(function () {
    toast('已复制链接', 'ok');
  }, function () {
    toast('复制失败', 'err');
  });
});

/* 待办复选框：change 事件委托（禁 inline handler） */
$('#feed').addEventListener('change', function (ev) {
  var t = ev.target;
  if (t && t.classList && t.classList.contains('todo-check-input')) {
    var card = t.closest('.post');
    if (card) toggleTodo(card.getAttribute('data-path'), t.checked);
  }
});

/* 整页硬刷新：Electron 走主进程 reloadIgnoringCache（连 /media 图片缓存一起清），
   web/安卓走普通 reload（index/assets 本就 no-store） */
function hardReloadPage() {
  if (location.protocol === 'gnapp:') {
    fetch('/__hard-reload').catch(function () { location.reload(); });
  } else {
    location.reload();
  }
}

$('#btn-refresh').onclick = function () {
  if (state.editingPath) { editCtx = null; state.editingPath = null; }
  state.query = '';
  state.searchHits = null;
  state.filter = '';
  state.timeRange = null;
  $('#search').value = '';
  if (!state.ready) { boot(); return; }
  if (state.stage === 'local') {   /* 仅本机：无远端可同步，直接整页刷新 */
    hardReloadPage();
    return;
  }
  status('同步中…');
  apiSync().then(function () {
    toast('已同步，正在刷新…', 'ok');
    hardReloadPage();
  }).catch(function (e) {
    toast('同步失败：' + e.message + '（已按本地内容显示）', 'err');
    refreshSyncStatus();
    initFeed();
  });
};
/* 页面路由：顶栏 🗒/✦/⚙（宽屏 ≥1024px 时信息流与 AI 恒双栏） */
$('#btn-nav-feed').onclick = function () { showView('feed'); };
$('#btn-nav-ai').onclick = function () { showView('ai'); };
$('#btn-nav-set').onclick = function () { showView('set'); };
/* 帮助文档：应用内独立视图 #view-help（内容单源 fetch help.html 注入，不再开新窗口；
   help.html 直开路由三端保留兼容，electron 子窗口/android onCreateWindow 作为旧缓存前端兜底） */
$('#btn-help').onclick = function () { showView('help'); };
var helpLoaded = false;
function loadHelpView() {
  if (helpLoaded) return;
  var box = $('#help-view-body');
  box.textContent = '正在加载帮助……';
  fetch('/help.html').then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.text();
  }).then(function (t) {
    var wrap = new DOMParser().parseFromString(t, 'text/html').querySelector('.help-wrap');
    if (!wrap) throw new Error('no .help-wrap');
    box.textContent = '';
    box.appendChild(document.importNode(wrap, true));
    helpLoaded = true;
  }).catch(function () {
    box.textContent = '帮助文档加载失败，请重试（切走再切回即可）。';
  });
}
$('#brand-home').onclick = function () { showView('feed'); };
$('#sync-pill').onclick = function () { showView('set'); };
$('#btn-open-repo').onclick = function () {
  api('POST', '/repo/open').then(function () { toast('已打开本地仓库文件夹', 'ok'); })
    .catch(function (e) { status('打开仓库失败：' + e.message, 'err'); });
};
$('#btn-open-repo-page').onclick = function () {
  api('POST', '/repo/open').then(function () { toast('已打开本地仓库文件夹', 'ok'); })
    .catch(function (e) { status('打开仓库失败：' + e.message, 'err'); });
};
/* 检测新版本：三端 /api/update/check 比对更新源，结果行就地展示（有新版附下载链接，web 版提示随仓库更新） */
$('#btn-check-update').onclick = function () {
  var btn = this;
  var out = $('#update-result');
  btn.disabled = true;
  out.hidden = false;
  out.textContent = '正在检测新版本……';
  api('GET', '/update/check').then(function (j) {
    if (j.error) { out.textContent = '检测失败：' + j.error + '（当前 v' + j.current + '）'; return; }
    if (!j.supported) { out.textContent = '当前 v' + j.current + ' · web 版随仓库运行，git pull 后重启服务即更新'; return; }
    if (j.updateAvailable) {
      showUpdateBtn(j.latest);
      out.textContent = '';
      out.appendChild(document.createTextNode('发现新版本 v' + j.latest + '（当前 v' + j.current + '）→ '));
      if (state.platform === 'android') {
        /* 安卓：应用内下载 APK 并拉起系统安装器（系统强制最后一步人工点「安装」） */
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = '下载并安装';
        b.setAttribute('data-u32-name', 'btn-install-update');
        b.onclick = function () {
          b.disabled = true;
          b.textContent = '正在下载……';
          api('POST', '/update/install').then(function () {
            b.textContent = '已拉起安装器，请在系统弹窗中点「安装」';
          }).catch(function (e) {
            b.textContent = '下载并安装';
            b.disabled = false;
            status('安装失败：' + e.message, 'err');
          });
        };
        out.appendChild(b);
      } else if (location.protocol === 'gnapp:') {
        /* Electron：与顶栏 ⬇ 按钮同一条链路（startUpdate），进度就地写在本行，不再给 <a> 直链 */
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = '下载并安装';
        b.setAttribute('data-u32-name', 'btn-install-update');
        b.onclick = function () {
          startUpdate({
            onProgress: function (t) { b.textContent = t; out.textContent = t; },
            onDone: function (t) { b.textContent = '下载并安装'; out.textContent = t; },
            onFail: function (m) { b.textContent = '下载并安装'; out.textContent = '更新失败：' + m; },
          });
        };
        out.appendChild(b);
      } else {
        /* 兜底：非 gnapp 非 android 的 supported 端（理论不出现）退回直链下载 */
        var a = document.createElement('a');
        a.href = j.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '下载 ' + (j.url.split('.').pop().toUpperCase()) + ' 安装包';
        out.appendChild(a);
      }
    } else {
      out.textContent = '已是最新版本 v' + j.current + '（更新源 v' + j.latest + '）';
    }
  }).catch(function (e) {
    out.textContent = '检测失败：' + e.message;
  }).finally(function () { btn.disabled = false; });
};
/* 一键更新统一流程（顶栏 ⬆ 按钮与设置页「下载并安装」共用，2026-10-28）：
   electron：POST /update/install 发起后台下载（main 进程），轮询 /update/progress 汇报百分比；
   下载中重复点击不发新请求，只报当前进度（updBusy 守卫 + updLastText 最近文案）。
   android：POST 同步下载 APK 并拉系统安装器；web 版随仓库更新不走此流程。
   启动静默检测 1h 节流（localStorage gnUpdateCheckAt），失败/无新版都保持按钮隐藏 */
/* 更新按钮即状态胶囊（一眼可见，不靠 toast/hover）：
   new=「⬆ 新版 v0.6.0」、dl=「⬇ 42%（12/89 MB）」实时、ready=「✔ 新版已就绪·点击安装」脉冲、err=失败可点重试、hide=还原隐藏 */
function updBtnState(mode, text) {
  var b = $('#btn-update'), t = $('#upd-text');
  if (!b || !t) return;
  b.classList.remove('dl', 'ready', 'err');
  t.hidden = mode === 'new';
  if (mode === 'hide') { b.hidden = true; return; }
  b.hidden = false;
  if (mode === 'new') { t.textContent = ''; b.title = '有新版本 v' + text + '，点击更新'; }
  else if (mode === 'dl') { t.textContent = text; b.title = text; }
  else if (mode === 'ready') { t.textContent = '✔ 新版已就绪 · 点击安装'; b.title = '新版本 v' + text + ' 已下载完成，点击安装'; }
  else if (mode === 'err') { b.classList.add('err'); t.textContent = '更新失败 · 点击重试'; b.title = '更新失败：' + text; }
  b.setAttribute('aria-label', b.title);
}
function showUpdateBtn(latest) { updBtnState('new', latest); }
/* 页面加载/重载后接续在途下载：轮询 progress 只喂胶囊，直到 ready/none（与 startUpdate 的轮询互不冲突，写同一状态源） */
var updWatchOn = false;
function updWatchPoll() {
  api('GET', '/update/progress').then(function (j) {
    if (!updWatchOn) return;
    if (j.phase === 'downloading') { updBtnState('dl', updProgressText(j)); setTimeout(updWatchPoll, 800); }
    else if (j.phase === 'ready') { updWatchOn = false; updBtnState('ready', j.latest); }
    else if (j.phase === 'none') { updWatchOn = false; }
    else { setTimeout(updWatchPoll, 800); }   /* checking / idle-awaiting-error：继续盯 */
  }).catch(function () { if (updWatchOn) setTimeout(updWatchPoll, 1600); });
}
function updWatchRestore() {
  if (location.protocol !== 'gnapp:' || updWatchOn) return;
  api('GET', '/update/progress').then(function (j) {
    if (j.phase === 'downloading') { updWatchOn = true; updBtnState('dl', updProgressText(j)); updWatchPoll(); }
    else if (j.phase === 'ready') updBtnState('ready', j.latest);
  }).catch(function () {});
}
var updBusy = false;
var updLastText = '';
function updMB(n) { return (n / 1048576).toFixed(1); }
function updProgressText(j) {
  var t = '正在下载 v' + j.latest + ' ' + j.percent + '%';
  if (j.total) t += '（' + updMB(j.received) + '/' + updMB(j.total) + ' MB）';
  return t;
}
function startUpdate(h) {
  h = h || {};
  if (updBusy) {
    var cur = updLastText || '更新进行中…';
    if (h.onProgress) h.onProgress(cur);
    toast(cur);
    return;
  }
  updBusy = true;
  updLastText = '';
  function done(t) { updBusy = false; if (h.onDone) h.onDone(t); }
  function fail(m) { updBusy = false; if (h.onFail) h.onFail(m); }
  if (location.protocol === 'gnapp:') {
    toast('开始下载更新……');
    api('POST', '/update/install').catch(function (e) { fail(e.message); });
    /* POST 发起后 main 进程异步走 检测→下载；progress 未就绪（idle 无 error）时继续轮询 */
    var poll = function () {
      if (!updBusy) return;
      api('GET', '/update/progress').then(function (j) {
        if (j.phase === 'downloading') {
          updLastText = updProgressText(j);
          updBtnState('dl', updLastText);
          if (h.onProgress) h.onProgress(updLastText);
        } else if (j.phase === 'ready') {
          updBtnState('ready', j.latest);
          done('新版本 v' + j.latest + ' 已下载，请在弹窗中确认安装');
          return;
        } else if (j.phase === 'none') {
          updBtnState('hide');
          done('当前已是最新版本');
          return;
        } else if (j.error) {
          updBtnState('err', j.error);
          fail(j.error);
          return;
        }
        setTimeout(poll, 800);
      }).catch(function () { setTimeout(poll, 800); });
    };
    setTimeout(poll, 400);
  } else {
    /* android：POST 同步完成下载并拉起系统安装器 */
    toast('正在下载更新……');
    api('POST', '/update/install').then(function () {
      updBtnState('hide');
      done('已拉起安装器，请在系统弹窗中点「安装」');
      toast('已拉起安装器，请在系统弹窗中点「安装」');
    }).catch(function (e) {
      updBtnState('err', e.message);
      fail(e.message);
      toast('更新失败：' + e.message, 'err');
    });
  }
}
$('#btn-update').onclick = function () {
  startUpdate({
    onDone: function (t) { toast(t, 'ok'); },
    onFail: function (m) { toast('更新失败：' + m, 'err'); },   /* 失败态已由胶囊 err 呈现，点击即重试 */
  });
};
function bootUpdateCheck() {
  try {
    var last = Number(localStorage.getItem('gnUpdateCheckAt')) || 0;
    if (Date.now() - last < 3600 * 1000) return;
  } catch (_) { /* localStorage 不可用则不节流，照常检测 */ }
  api('GET', '/update/check').then(function (j) {
    try { localStorage.setItem('gnUpdateCheckAt', String(Date.now())); } catch (_) {}
    if (j.supported && j.updateAvailable) showUpdateBtn(j.latest);
  }).catch(function () { /* 静默：网络失败不打扰 */ });
  updWatchRestore();   /* 接续页面重载前已在途的下载/已就绪状态 */
}
/* 外观三选一 */
$('#theme-opts').addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-theme-opt]');
  if (b) setThemePref(b.getAttribute('data-theme-opt'));
});
/* 字号滑动条（input 事件实时应用，change 才落 localStorage 减少写入） */
$('#font-slider').addEventListener('input', function () {
  var v = Math.round(Number(this.value));
  if (!(v >= FONT_SIZE_MIN && v <= FONT_SIZE_MAX)) return;
  document.documentElement.style.setProperty('--fs-post', v + 'px');
  $('#font-val').textContent = v + 'px';
});
$('#font-slider').addEventListener('change', function () {
  setFontSizePref(Math.round(Number(this.value)));
});
/* dock：移动端漏斗筛选浮层与发布器折叠 */
$('#btn-funnel').onclick = function () { $('#filter-row').classList.toggle('show'); };
$('#compose-mini').onclick = expandCompose;
/* 移动端触屏点按按钮不产生 relatedTarget（按钮不获焦），focusout 会误判「焦点离开」；
   用 pointerdown 捕获阶段记录最近一次按住位置，按在发布器内则不收回 */
var lastPressInComposer = false;
document.addEventListener('pointerdown', function (ev) {
  lastPressInComposer = !!(ev.target && ev.target.closest && ev.target.closest('#composer'));
}, true);
$('#composer').addEventListener('focusout', function (ev) {
  /* 焦点离开发布器（且不是移入其内部按钮/最近按点在其内）才收回折叠；宽屏无折叠态无副作用 */
  if (!wideMq.matches && !this.contains(ev.relatedTarget) && !lastPressInComposer) collapseCompose();
});
/* 设置页：新增标签 */
$('#btn-add-tag').onclick = function () {
  var inp = $('#new-tag-input');
  if (!cleanTag(inp.value)) { toast('错误：标签名为空', 'err'); return; }
  addTagGlobal(inp.value, function () {
    inp.value = '';
    renderSettingsTags();
    renderCapChips();
    renderFilter();
  });
};
$('#new-tag-input').onkeydown = function (ev) { if (ev.key === 'Enter') $('#btn-add-tag').click(); };
/* 搜索：防抖 300ms 全库搜索（服务端支持拼音/首字母匹配） */
$('#search').addEventListener('input', function () {
  clearTimeout(searchTimer);
  var v = this.value;
  searchTimer = setTimeout(function () {
    var q = v.trim();
    if (state.query === q && (q === '' || state.searchHits)) return;
    runSearch(q);
  }, 300);
});
/* 设置页：同步与公钥 */
$('#btn-sync').onclick = function () {
  var btn = $('#btn-sync');
  btn.disabled = true;
  status('同步中…');
  apiSync().then(function () {
    toast('已同步', 'ok');
    settleStatus();
    return refreshSyncStatus();
  }).catch(handleApiError).finally(function () { btn.disabled = false; });
};
$('#btn-show-pubkey').onclick = function () {
  /* 无密钥时先按需生成（apiSetupKey 幂等：已有则原样返回），双端一致；
     生成后立即刷新设置页，让「重新生成密钥」随之出现 */
  apiSetupKey().then(function (r) {
    state.hasKey = true;
    renderSyncInfo();
    pubKeyDlg(r.pubKey);
  }).catch(handleApiError);
};
$('#btn-rotate-key').onclick = function () {
  dlg('重新生成 SSH 密钥', {
    text: '将删除本机当前 SSH 密钥并生成新的 ed25519 密钥对，旧密钥立即作废。若已绑定 SSH 远端，必须把新公钥重新添加到 git 服务器，否则之后同步会失败。确定重新生成？',
    ok: '重新生成', danger: true
  }).then(function (yes) {
    if (!yes) return;
    status('正在生成新密钥…');
    apiRotateKey().then(function (r) {
      toast('已重新生成密钥（旧密钥已删除）', 'ok');
      settleStatus();
      refreshSyncStatus();
      pubKeyDlg(r.pubKey);
    }).catch(handleApiError);
  });
};
/* 引导页：双岔路 */
$('#btn-local-mode').onclick = function () {
  $('#btn-local-mode').disabled = true;
  apiSetupLocal().then(function () {
    $('#setup').hidden = true;
    toast('已创建本地仓库（仅本机模式）', 'ok');
    boot();
  }).catch(function (e) {
    $('#btn-local-mode').disabled = false;
    toast('错误：' + e.message, 'err');
  });
};
$('#btn-clone-mode').onclick = function () { openSetupBind('guide'); };
$('#btn-back-choice').onclick = function () {
  /* 设置页进来的绑定面板：返回=收起面板回设置页；首次引导：返回=回欢迎双卡片 */
  if (setupFrom === 'settings') { closeSetupPanel(); return; }
  $('#setup-clone').hidden = true;
  $('#setup-error').hidden = true;
  $('#pubkey-sec').hidden = true;
  $('#setup-choice').hidden = false;
};
$('#btn-do-clone').onclick = setupConnectFlow;
$('#btn-copy-pubkey').onclick = function () { copyBox('#pubkey-box'); };
/* 引导克隆：输入 SSH 地址即主动展示公钥（公钥常显后此钩子仅兜底） */
watchSshKeyHint('#clone-remote', '#pubkey-sec', '#pubkey-box');
/* 设置页【绑定远端】：打开同一块三步绑定视图（local 态「连接」自动走探测+绑定） */
$('#btn-bind-remote').onclick = function () { openSetupBind('settings'); };
/* 合并预览（local 态远端有数据时）：确认合并 / 冲突强制推送 / 取消 */
$('#btn-setup-merge').onclick = function () {
  var btn = $('#btn-setup-merge');
  btn.disabled = true;
  $('#setup-merge-error').hidden = true;
  $('#btn-setup-merge-force').hidden = true;
  $('#clone-progress').textContent = '合并中…';
  $('#clone-progress').hidden = false;
  apiBindMerge().then(function () {
    btn.disabled = false;
    $('#clone-progress').hidden = true;
    bindConnectDone();
  }).catch(function (e) {
    btn.disabled = false;
    $('#clone-progress').hidden = true;
    var er = $('#setup-merge-error');
    if (e.conflict) {
      er.textContent = '自动合并失败（' + (e.conflict || []).join('、') + '）：rebase 与 merge 均无法完成。可「强制推送」以本地为准覆盖远端，或「取消绑定」。';
      er.hidden = false;
      $('#btn-setup-merge-force').hidden = false;
    } else {
      er.textContent = e.message;
      er.hidden = false;
    }
  });
};
$('#btn-setup-merge-force').onclick = function () {
  dlg('强制推送（绑定）', { text: '将以本地内容为准覆盖远端历史：远端上本地没有的提交（可能含既有笔记）将丢失。确定继续？', ok: '强制推送', danger: true }).then(function (yes) {
    if (!yes) return;
    $('#btn-setup-merge-force').disabled = true;
    $('#clone-progress').textContent = '强制推送中…';
    $('#clone-progress').hidden = false;
    apiBindForcePush().then(function () {
      $('#btn-setup-merge-force').disabled = false;
      $('#clone-progress').hidden = true;
      bindConnectDone();
    }).catch(function (e) {
      $('#btn-setup-merge-force').disabled = false;
      $('#clone-progress').hidden = true;
      var er = $('#setup-merge-error');
      er.textContent = e.message;
      er.hidden = false;
    });
  });
};
$('#btn-setup-merge-abort').onclick = function () {
  apiBindCancel().catch(function () {}).then(function () {
    $('#setup').hidden = true;
    $('#setup-merge').hidden = true;
    toast('已取消绑定', '');
    if (setupFrom === 'settings') renderSettingsPage();
  });
};
/* 解绑与强制推送 */
$('#btn-unbind').onclick = function () {
  dlg('解绑远端', { text: '解除远端绑定后回到仅本机模式；本地数据不受影响，远端仓库也不会被改动。', ok: '解绑' }).then(function (yes) {
    if (!yes) return;
    apiUnbind().then(function () {
      toast('已解绑远端（仅本机模式）', 'ok');
      refreshSyncStatus();
    }).catch(handleApiError);
  });
};
$('#btn-force-push').onclick = function () {
  dlg('强制推送', { text: '将以本地内容为准覆盖远端历史：远端上本地没有的提交将丢失。确定继续？', ok: '强制推送', danger: true }).then(function (yes) {
    if (!yes) return;
    status('强制推送中…');
    apiForcePush().then(function () {
      toast('已强制推送（本地为准）', 'ok');
      settleStatus();
      refreshSyncStatus();
    }).catch(handleApiError);
  });
};

$('#dlg-ok').onclick = function () {
  var input = $('#dlg-input');
  var tarea = $('#dlg-textarea');
  var err = $('#dlg-error');
  if (!input.hidden) {
    var v = input.value.trim();
    if (!v) { err.textContent = '内容不能为空'; err.hidden = false; return; }
    closeDlg(v);
  } else if (!tarea.hidden) {
    var tv = tarea.value.trim();
    if (!tv) { err.textContent = '内容不能为空'; err.hidden = false; return; }
    closeDlg(tv);
  } else {
    closeDlg(true);
  }
};
$('#dlg-cancel').onclick = function () { closeDlg(null); };
$('#dlg-input').onkeydown = function (ev) { if (ev.key === 'Enter') $('#dlg-ok').click(); };

/* 时间段筛选面板 */
$('#tr-cancel').onclick = function () { $('#trdlg').hidden = true; };
$('#tr-apply').onclick = applyTimeRange;
$('#tr-clear').onclick = clearTimeRange;
$('#tr-from').addEventListener('input', renderTrPresets);
$('#tr-to').addEventListener('input', renderTrPresets);
$('#dlg-textarea').addEventListener('keydown', function (ev) {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); $('#dlg-ok').click(); }
});

$('#lb-close').onclick = closeLb;
$('#lb-prev').onclick = function () { lbMove(-1); };
$('#lb-next').onclick = function () { lbMove(1); };
$('#lightbox').addEventListener('click', function (ev) {
  if (ev.target === this) closeLb();
});
/* 右键菜单：点任意处关闭（菜单项自身的 click 先于本监听执行，不冲突） */
document.addEventListener('click', function () { lbMenuHide(); });
ioMore.observe($('#feed-sentinel'));

/* 回到最新：滚动容器是 #feed-scroll（倒排信息流新帖贴底，上滑远离底部时浮现） */
var feedScroll = $('#feed-scroll');
feedScroll.addEventListener('scroll', function () {
  var far = feedScroll.scrollHeight - feedScroll.scrollTop - feedScroll.clientHeight > 600;
  $('#btn-bottom').hidden = !far;
}, { passive: true });
$('#btn-bottom').onclick = function () { feedScroll.scrollTo({ top: feedScroll.scrollHeight, behavior: 'smooth' }); };
/* 贴底钉扎：图片解码/懒加载改变内容高度时，本在底部就保持钉在最新（capture 捕获所有帖内图片） */
$('#feed').addEventListener('load', function (e) {
  if (e.target && e.target.tagName === 'IMG' && feedAtBottom()) feedPinBottom();
}, true);

document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') {
    if (!$('#lb-menu').hidden) lbMenuHide();
    else if (!$('#lightbox').hidden) closeLb();
    else if (!$('#dlg').hidden) closeDlg(null);
    else if (!$('#trdlg').hidden) $('#trdlg').hidden = true;
    else if (!$('#setup').hidden) {
      /* 首次引导不允许 Esc 关闭（未完成配置无法使用）；设置页进来的绑定面板可关 */
      if (setupFrom === 'settings') closeSetupPanel();
    }
    else if (curView === 'set' || curView === 'help') showView('feed');
    else if (state.query) { $('#search').value = ''; runSearch(''); }
  }
  if (!$('#lightbox').hidden) {
    if (ev.key === 'ArrowLeft') lbMove(-1);
    if (ev.key === 'ArrowRight') lbMove(1);
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
    ev.preventDefault();
    if (editCtx) saveEdit();
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && editCtx) { ev.preventDefault(); saveEdit(); }
  /* / 聚焦搜索（信息流页、输入框未聚焦、灯箱关闭时） */
  if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    var ae = document.activeElement, tg = ae && ae.tagName;
    if (curView === 'feed' && tg !== 'INPUT' && tg !== 'TEXTAREA' && $('#lightbox').hidden) {
      ev.preventDefault();
      $('#search').focus();
    }
  }
});
wideMq.addEventListener('change', function () { updateComposePlaceholder(); });
window.addEventListener('beforeunload', function (ev) {
  if ($('#cap-input').value.trim() || capImages.length || editCtx) { ev.preventDefault(); ev.returnValue = ''; }
});

renderCapChips();
renderFilter();
renderSentinel();
updateComposePlaceholder();
showView('feed');
boot();
/* 启动后延迟静默检测新版本（等 boot 拿到状态、错开首屏加载） */
setTimeout(bootUpdateCheck, 8 * 1000);
