'use strict';
/* ================= 设置页（同步 + 分支 + 标签 + 关于） ================= */
/* 顶栏同步徽章：分支名 + 同步态（与 renderSyncInfo 同数据源；fresh/cloning 阶段隐藏） */
function renderSyncPill() {
  var pill = $('#sync-pill');
  if (!state.ready) { pill.hidden = true; return; }
  var isLocal = state.stage === 'local';
  var hasConflict = !!(syncInfo.conflict && syncInfo.conflict.length);
  var cls = 'ok', statusText;
  if (isLocal) statusText = '仅本机';
  else if (hasConflict) { statusText = '冲突'; cls = 'err'; }
  else if (syncInfo.lastError) { statusText = '同步失败'; cls = 'err'; }
  else if (syncInfo.ahead || syncInfo.behind) statusText = '↑' + syncInfo.ahead + ' ↓' + syncInfo.behind;
  else statusText = '已同步';
  pill.hidden = false;
  pill.className = 'sync-pill ' + cls;
  $('#sync-pill-text').textContent = (state.branch ? state.branch + ' · ' : '') + statusText;
  $('#btn-open-repo').hidden = state.platform === 'android';
}
function renderSyncInfo() {
  var el = $('#sync-info');
  var err = $('#sync-error');
  var remoteEl = $('#sync-remote');
  var isLocal = state.stage === 'local';
  var hasConflict = !!(syncInfo.conflict && syncInfo.conflict.length);
  $('#btn-show-pubkey').hidden = false;   /* 常显：无密钥时点击即按需生成，避免新设备「先有鸡」死锁 */
  $('#btn-rotate-key').hidden = !state.hasKey;
  $('#btn-import-key').hidden = false;    /* 常显：导入即可代替生成，同样不许以「已有密钥」为前提 */
  $('#btn-export-key').hidden = !state.hasKey;
  $('#btn-bind-remote').hidden = !isLocal;
  $('#btn-ai-bind').hidden = !isLocal;
  $('#btn-unbind').hidden = isLocal;
  $('#btn-sync').hidden = isLocal;
  $('#btn-force-push').hidden = !hasConflict;
  $('#ai-hint').hidden = !hasConflict;
  $('#key-status').textContent = state.hasKey ? '本机密钥：已生成（ed25519）' : '本机密钥：未生成（点「查看公钥」自动生成）';
  renderSyncPill();
  if (isLocal) {
    remoteEl.hidden = false;
    remoteEl.textContent = '远端：未绑定（仅本机使用）';
    el.textContent = '数据只存本机（~/.git-notes/repo），绑定远端后可多设备同步。';
    err.hidden = true;
    return;
  }
  remoteEl.hidden = false;
  remoteEl.textContent = '远端：' + (state.remote || '（未知）');
  var parts = [];
  if (!syncInfo.ahead && !syncInfo.behind) parts.push('已同步');
  else parts.push('本地领先 ' + syncInfo.ahead + ' · 落后 ' + syncInfo.behind);
  parts.push('↑' + syncInfo.ahead + ' ↓' + syncInfo.behind);
  parts.push('上次同步 ' + fmtTime(syncInfo.lastAt));
  el.textContent = parts.join(' · ');
  if (syncInfo.lastError) { err.textContent = '上次同步失败：' + syncInfo.lastError; err.hidden = false; }
  else err.hidden = true;
}
/* 设置独立页（#view-set）：进入页面时刷新各区块数据 */
function renderSettingsPage() {
  renderSyncInfo();
  renderSettingsTags();
  renderThemeOpts();
  renderFontOpts();
  aiLoadConf().then(aiSettingsLoad);
  /* 版本行 = /healthz 基础信息 + /assets/version.json 构建溯源（electron/android 构建时注入，web 服务启动时现算） */
  var base = '';
  var build = '';
  var buildSubject = '';
  var render = function () {
    var el = $('#about-version');
    el.textContent = base + build;
    if (buildSubject) el.title = buildSubject;
  };
  fetch('/healthz').then(function (r) { return r.json(); }).then(function (j) {
    base = '版本 v' + j.version + ' · 本地服务运行中（PID ' + j.pid + '）';
    render();
  }).catch(function () {});
  fetch('/assets/version.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
    if (!v || !v.commit) return;
    var d = v.time ? new Date(v.time) : null;
    var t = (d && !isNaN(d.getTime()))
      ? pad2(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
      : '';
    build = ' · 构建 ' + v.commit + (t ? ' · ' + t : '');
    buildSubject = v.subject || '';
    render();
  }).catch(function () {});
}
/* 外观三选一（浅/深/跟随系统；写 localStorage.gnTheme 并即时应用） */
function renderThemeOpts() {
  var cur = themePref();
  var btns = document.querySelectorAll('#theme-opts [data-theme-opt]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('on', btns[i].getAttribute('data-theme-opt') === cur);
  }
}
/* 字号滑动条（写 localStorage.gnFontSize 并即时应用，10–50px） */
function renderFontOpts() {
  var cur = fontSizePref();
  var slider = $('#font-slider');
  if (!slider) return;
  slider.value = cur;
  $('#font-val').textContent = cur + 'px';
}
var dlgResolve = null;
function dlg(title, opts) {
  opts = opts || {};
  $('#dlg-title').textContent = title;
  var txt = $('#dlg-text');
  txt.textContent = opts.text || '';
  txt.hidden = !opts.text;
  txt.className = opts.mono ? 'hint dlg-mono' : 'hint';
  var copyRow = $('#dlg-copy-row');
  copyRow.hidden = !opts.copy;
  if (opts.copy) $('#btn-dlg-copy').onclick = function () { copyText(opts.copy, txt); };
  var input = $('#dlg-input');
  var tarea = $('#dlg-textarea');
  input.hidden = !opts.input || !!opts.multiline;
  input.placeholder = opts.input || '';
  input.value = '';
  tarea.hidden = !opts.multiline;
  tarea.placeholder = opts.multiline === true ? '' : opts.multiline;
  tarea.value = '';
  var ok = $('#dlg-ok');
  ok.textContent = opts.ok || '确定';
  ok.className = opts.danger ? 'danger' : 'primary';
  $('#dlg-cancel').hidden = opts.noCancel === true;
  $('#dlg-error').hidden = true;
  $('#dlg').hidden = false;
  if (opts.multiline) tarea.focus();
  else if (opts.input) input.focus();
  else ok.focus();
  return new Promise(function (resolve) { dlgResolve = resolve; });
}
function closeDlg(v) {
  $('#dlg').hidden = true;
  if (dlgResolve) { dlgResolve(v); dlgResolve = null; }
}
/* 本机 SSH 公钥弹窗（等宽盒 + 复制按钮，设置页/绑定向导/密钥重生成共用） */
function pubKeyDlg(pubKey) {
  dlg('本机 SSH 公钥', {
    text: pubKey + '\n\n把上面一行添加到 git 服务器「个人设置 → SSH 公钥」；私钥永不出本机（PC 在 ~/.git-notes/keys/，手机在应用私有目录）。',
    mono: true, copy: pubKey, ok: '关闭', noCancel: true
  });
}

/* 导入 / 导出私钥 */
$('#btn-import-key').onclick = function () {
  dlg('导入 SSH 私钥', {
    text: '粘贴 OpenSSH 格式私钥（-----BEGIN … PRIVATE KEY----- 开头，需无口令）。' + (state.hasKey ? '本机已有密钥，导入将覆盖它，旧公钥在 git 服务器上立即失效。' : '导入后请把返回的公钥添加到 git 服务器。'),
    multiline: '-----BEGIN OPENSSH PRIVATE KEY-----',
    ok: '导入'
  }).then(function (v) {
    if (!v) return;
    status('导入中…');
    apiImportKey(v).then(function (r) {
      state.hasKey = true;
      renderSyncInfo();
      toast('私钥已导入', 'ok');
      settleStatus();
      pubKeyDlg(r.pubKey);
    }).catch(handleApiError);
  });
};
$('#btn-export-key').onclick = function () {
  dlg('导出 SSH 私钥', {
    text: '私钥是本机仓库的敏感凭证，泄露等于交出远端仓库的写权限。导出仅用于迁移到其他设备或备份，确定继续？',
    ok: '导出', danger: true
  }).then(function (yes) {
    if (!yes) return;
    apiPrivateKey().then(function (r) {
      return dlg('本机 SSH 私钥（请妥善保管）', {
        text: r.privateKey, mono: true, copy: r.privateKey, ok: '关闭', noCancel: true
      });
    }).catch(handleApiError);
  });
};

/* ================= 首次引导（岔路）与克隆 ================= */
var pollTimer = null;
function needPubKey(e) { return (e && e.needPubKey === true) || /publickey|permission denied/i.test((e && e.message) || ''); }
function isSshAddr(u) { return /^[\w.-]+@[\w.-]+:/.test(u || '') || /^ssh:\/\//.test(u || ''); }
/* 地址输入为 SSH 时主动展示本机公钥（密钥按需生成），不等探测/克隆失败才出现 */
function watchSshKeyHint(inputSel, secSel, boxSel) {
  var ensuring = null;
  $(inputSel).addEventListener('input', function () {
    if (!isSshAddr(this.value)) { $(secSel).hidden = true; return; }
    $(secSel).hidden = false;
    if ($(boxSel).value) return;
    if (!ensuring) {
      ensuring = apiSetupKey().catch(function (e) { ensuring = null; handleApiError(e); return null; });
    }
    ensuring.then(function (r) {
      if (r && r.pubKey) $(boxSel).value = r.pubKey;
    });
  });
}
function openSetup(st) {
  setupFrom = 'guide';
  $('#setup').hidden = false;
  $('#setup-error').hidden = true;
  $('#clone-progress').hidden = true;
  $('#pubkey-sec').hidden = true;
  $('#btn-do-clone').disabled = false;
  $('#btn-do-clone').textContent = '连 接';
  if (st && st.stage === 'cloning') {   /* 页面在克隆进行中被刷新：恢复进度视图 */
    $('#setup-choice').hidden = true;
    $('#setup-clone').hidden = false;
    pollClone();
    return;
  }
  $('#setup-choice').hidden = false;
  $('#setup-clone').hidden = true;
}
/* 进入「多端同步」三步视图：from='settings' 时由设置页【绑定远端】进入（跳过欢迎卡片，Esc/返回可关）；
   切视图并按需生成本机公钥立即展示（幂等，密钥未生成时此处生成） */
function openSetupBind(from) {
  setupFrom = from || 'guide';
  $('#setup').hidden = false;
  $('#setup-choice').hidden = true;
  $('#setup-clone').hidden = false;
  $('#setup-error').hidden = true;
  $('#clone-progress').hidden = true;
  $('#pubkey-sec').hidden = true;
  $('#clone-remote').value = '';
  $('#clone-remote').focus();
  apiSetupKey().then(function (r) {
    $('#pubkey-box').value = r.pubKey;
    $('#pubkey-sec').hidden = false;
  }).catch(function (e) { status('错误：' + e.message, 'err'); });
}
function copyText(v, fallbackEl) {
  if (!v) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(v).then(function () { toast('已复制到剪贴板', 'ok'); }, function () { fallbackCopy(fallbackEl, v); });
  } else {
    fallbackCopy(fallbackEl, v);
  }
}
function copyBox(boxId) { var box = $(boxId); copyText(box.value, box); }
function fallbackCopy(el, v) {
  if (el && el.select) { el.focus(); el.select(); }
  else if (el) {
    var r = document.createRange();
    r.selectNodeContents(el);
    var s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
  }
  try {
    if (document.execCommand('copy')) toast('已复制到剪贴板', 'ok');
    else toast('复制失败，请手动选择复制', 'err');
  } catch (_) { toast('复制失败，请手动选择复制', 'err'); }
}
function showClonePubKey() {
  apiSetupKey().then(function (r) {
    $('#pubkey-box').value = r.pubKey;
    $('#pubkey-sec').hidden = false;
    $('#btn-do-clone').disabled = false;
    $('#btn-do-clone').textContent = '重试连接';
  }).catch(function (e) { status('错误：' + e.message, 'err'); });
}
function pollClone() {
  if (pollTimer) return;
  var prog = $('#clone-progress');
  prog.hidden = false;
  pollTimer = setInterval(function () {
    apiStatus().then(function (st) {
      if (st.stage === 'local' || st.stage === 'ready') {
        clearInterval(pollTimer); pollTimer = null;
        prog.textContent = '连接成功！';
        toast('已连上远端仓库', 'ok');
        setTimeout(function () {
          $('#setup').hidden = true;
          boot();
        }, 600);
        return;
      }
      if (st.clone && st.clone.error) {
        clearInterval(pollTimer); pollTimer = null;
        if (/publickey|permission denied/i.test(st.clone.error)) {
          showClonePubKey();
          prog.hidden = true;
          return;
        }
        var e = $('#setup-error');
        e.textContent = '克隆失败：' + st.clone.error;
        e.hidden = false;
        $('#btn-do-clone').disabled = false;
        prog.hidden = true;
        return;
      }
      if (st.clone && st.clone.active) {
        prog.textContent = '克隆中：' + (st.clone.phase || '进行中') + ' ' + (st.clone.progress || 0) + '%';
      }
    }).catch(function () {});
  }, 1000);
}
function startCloneFlow() {
  var remote = $('#clone-remote').value.trim();
  if (!remote) { var e0 = $('#setup-error'); e0.textContent = '请填写仓库地址'; e0.hidden = false; return; }
  if (!assertSshAddr(remote)) return;
  $('#btn-do-clone').disabled = true;
  $('#setup-error').hidden = true;
  $('#pubkey-sec').hidden = true;
  $('#clone-progress').textContent = '连接中…';
  $('#clone-progress').hidden = false;
  apiSetupClone(remote).then(pollClone).catch(function (e) {
    $('#btn-do-clone').disabled = false;
    $('#clone-progress').hidden = true;
    if (needPubKey(e)) { showClonePubKey(); return; }
    var er = $('#setup-error');
    er.textContent = '连接失败：' + e.message;
    er.hidden = false;
  });
}

/* ================= 绑定（统一走三步绑定视图：fresh→克隆 / local→探测+绑定+合并预览） ================= */
/* 面板来源：'guide'=首次引导（Esc 不可关、返回回欢迎页）；'settings'=设置页【绑定远端】（可关、返回直接收起） */
var setupFrom = 'guide';
function closeSetupPanel() {
  $('#setup').hidden = true;
  if (setupFrom === 'settings') renderSettingsPage();
}
function setupErr(msg) { var e = $('#setup-error'); e.textContent = msg; e.hidden = false; }
/* 连接成功收尾：只关面板，绝不弹后续面板、不自动同步——首次合并由用户点设置页「立即同步」触发 */
function bindConnectedDone(msg) {
  $('#setup').hidden = true;
  $('#clone-progress').hidden = true;
  toast(msg || '已连接远端', 'ok');
  boot(true);
}
/* 绑定面板只收 SSH 地址：https 克隆可能侥幸成功但推送必败（无凭证），引导期一律拦下 */
function assertSshAddr(remote) {
  if (/^https?:\/\//i.test(remote)) { setupErr('请粘贴 SSH 地址（git@ 开头），不要用 https:// 地址'); return false; }
  return true;
}
/* AI 绑定两步走：①弹「创建私人令牌」面板（令牌不落盘）→ ②生成含令牌+本机公钥的提示词
   供复制到 workbuddy 等 AI 工具（AI 凭令牌调平台 API 加公钥+建私有空仓），粘贴返回的
   SSH 地址后只登记远端（bindConnect）；完成后提醒用户回平台删除令牌 */
function aiBindFlow() {
  $('#ai-token-input').value = '';
  $('#aitoken-error').hidden = true;
  $('#aitoken').hidden = false;
  $('#ai-token-input').focus();
}
function aiBindPromptV2(token, pubKey) {
  return '我有一个 Git 平台的私人令牌（已授权仓库/项目与 SSH 公钥权限），请用它帮我完成下面两件事；除调用 API 外不要把它写进任何文件或发给他人：\n'
    + '私人令牌：' + token + '\n'
    + '平台识别：令牌以 ghp_ 或 github_pat_ 开头则为 GitHub，否则按 Gitee 处理。\n'
    + '1. 调平台 API 把下面这台设备的 SSH 公钥添加到我账号（Gitee：POST https://gitee.com/api/v5/user/keys，参数 key=公钥、title=git-notes；GitHub：POST https://api.github.com/user/keys）：\n'
    + pubKey + '\n'
    + '2. 创建一个【私有（Private）】空仓库，仓库名 git-notes，不要初始化 README（Gitee：POST https://gitee.com/api/v5/user/repos，private=true；GitHub：POST https://api.github.com/user/repos，private=true）。\n'
    + '完成后，只回复一行该仓库的 SSH 地址（格式如 git@gitee.com:用户名/git-notes.git），不要输出其他内容。';
}
function aiBindStep2(token) {
  apiSetupKey().then(function (r) {
    var prompt = aiBindPromptV2(token, r.pubKey);
    dlg('让 AI 绑定远端 · ② 让 AI 代办', {
      text: '把整段提示词复制到 workbuddy 等 AI 工具执行（它会凭令牌加公钥并创建私有空仓库）；把 AI 返回的 SSH 地址粘贴到下面点连接。配置完成后建议回平台删除该令牌，更安全。\n\n' + prompt,
      mono: true,
      copy: prompt,
      input: '粘贴 AI 返回的 SSH 地址，如 git@gitee.com:you/git-notes.git',
      ok: '连 接'
    }).then(function (v) {
      if (!v) return;
      apiBindConnect(v).then(function () {
        $('#setup').hidden = true;
        $('#setup-clone').hidden = true;
        bindConnectedDone('已连接远端，点设置页「立即同步」完成首次同步；建议删除刚才的私人令牌');
      }).catch(function (e) { status('错误：' + e.message, 'err'); });
    });
  }).catch(function (e) { status('错误：' + e.message, 'err'); });
}
/* local 态「连接」：只登记远端地址（git remote add origin），不联网校验、不合并不推送；
   首次同步由用户在设置页点「立即同步」触发 */
function bindConnectFlow() {
  var remote = $('#clone-remote').value.trim();
  if (!remote) { setupErr('请填写仓库地址'); return; }
  if (!assertSshAddr(remote)) return;
  $('#btn-do-clone').disabled = true;
  $('#setup-error').hidden = true;
  apiBindConnect(remote).then(function () {
    $('#btn-do-clone').disabled = false;
    $('#setup-clone').hidden = true;
    bindConnectedDone('已连接远端，点设置页「立即同步」完成首次同步');
  }).catch(function (e) {
    $('#btn-do-clone').disabled = false;
    setupErr(e.message);
  });
}
/* 「连接」按钮统一入口：首次使用（fresh）走克隆，已有本地笔记（local）走探测绑定 */
function setupConnectFlow() {
  if (state.stage === 'local') { bindConnectFlow(); return; }
  startCloneFlow();
}

/* 打开页面后台自动同步（ready 时）：首屏先渲染本地内容，成功后静默刷新到远端最新 */
function bootSync() {
  if (state.stage !== 'ready' || !state.ready) return;
  status('同步中…');
  apiSync().then(function () {
    return refreshSyncStatus();
  }).then(function () {
    return initFeed();
  }).then(function () {
    if (!feed.error) { toast('已同步最新', 'ok'); settleStatus(); }
  }).catch(function () {
    /* 静默降级：失败详情在设置页「上次同步失败」可见；409=已有同步/写操作在进行，无需打扰 */
    refreshSyncStatus();
    if (!feed.error) settleStatus();
  });
}

/* ================= 启动 ================= */
/* skipSync=true：跳过打开页面的自动同步（连接远端后用——首次合并必须由用户手动点「立即同步」） */
function boot(skipSync) {
  apiStatus().then(function (st) {
    state.stage = st.stage;
    state.platform = st.platform || '';
    state.remote = st.remote || '';
    state.branch = st.branch || '';
    state.hasKey = !!(st.key && st.key.exists);
    if (st.stage === 'fresh' || st.stage === 'cloning') {
      state.ready = false;
      openSetup(st);
      return;
    }
    state.ready = true;
    applySyncInfo(st.sync);
    renderSyncInfo();
    loadTags().then(initFeed).then(function () {
      if (!feed.error) settleStatus();
      if (!skipSync) bootSync();
    });
  }).catch(function (e) {
    toast('连接本地服务失败：' + e.message, 'err');
  });
}
