/* ================= AI 自我认知与自我配置工具（挂在 80-ai.js 之后：
   往 AI_TOOLS/AI_EXEC/AI_TOOL_LABEL 注册，只读/门控清单经 AI_RO_TOOLS/AI_GATE_TOOLS 注入 80-ai.js 的钩子） ================= */

var AI_RO_TOOLS = ['app_info', 'set_font_size', 'set_theme', 'ssh_key_info'];
var AI_GATE_TOOLS = ['set_tags', 'ssh_key_rotate', 'ssh_key_import', 'open_url'];

AI_TOOL_LABEL.app_info = '查询应用信息';
AI_TOOL_LABEL.set_font_size = '查询/设置字号';
AI_TOOL_LABEL.set_theme = '查询/设置主题';
AI_TOOL_LABEL.set_tags = '管理标签清单';
AI_TOOL_LABEL.ssh_key_info = '查看 SSH 公钥';
AI_TOOL_LABEL.ssh_key_rotate = '重新生成 SSH 密钥';
AI_TOOL_LABEL.ssh_key_import = '导入 SSH 私钥';
AI_TOOL_LABEL.open_url = '用系统浏览器打开网页';

function aiPlatformName(p) {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux', android: 'Android' }[p] || (p || '未知');
}

function tAppInfo() {
  return Promise.all([
    fetch('/assets/version.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    api('GET', '/status')
  ]).then(function (rs) {
    var v = rs[0] || {};
    var st = rs[1] || {};
    var lines = [
      '应用：' + APP_META.name,
      '版本：v' + (st.version || v.version || '未知') + (v.commit ? '（构建 ' + String(v.commit).slice(0, 10) + (v.time ? ' · ' + v.time.slice(0, 10) : '') + '）' : ''),
      '官网：' + APP_META.homepage,
      '开源：' + APP_META.github,
      '运行端：' + aiPlatformName(st.platform || state.platform),
      '仓库阶段：' + (st.stage || state.stage || '未知') + (st.remote ? '，已绑定远端' : '，仅本机'),
      'SSH 密钥：' + (st.key && st.key.exists ? '已生成（用 ssh_key_info 查公钥）' : '未生成'),
      'AI 权限模式：' + aiMode(),
      '源码：本仓库 web/ 目录（前端三端共用）+ electron/（桌面壳）+ android/（安卓壳）'
    ];
    return lines.join('\n');
  });
}

function tSetFontSize(a) {
  if (a.size == null || a.size === '') {
    return Promise.resolve('当前正文字号：' + fontSizePref() + 'px（范围 10–50px，默认 14px）。要调整请传 size 参数。');
  }
  var n = Math.round(Number(a.size));
  if (!(n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX)) return Promise.resolve('错误：size 须为 ' + FONT_SIZE_MIN + '–' + FONT_SIZE_MAX + ' 的整数，收到：' + a.size);
  var old = fontSizePref();
  setFontSizePref(n);
  return Promise.resolve(old === n ? '字号已是 ' + n + 'px，无需调整。' : '已把正文字号从 ' + old + 'px 调整为 ' + n + 'px，设置页滑动条已同步。');
}

function tSetTheme(a) {
  if (a.theme == null || a.theme === '') {
    return Promise.resolve('当前主题：' + themePref() + '（可选 light=浅色 / dark=深色 / auto=跟随系统）。要切换请传 theme 参数。');
  }
  var t = String(a.theme);
  if (['light', 'dark', 'auto'].indexOf(t) === -1) return Promise.resolve('错误：theme 只能是 light / dark / auto，收到：' + a.theme);
  var old = themePref();
  setThemePref(t);
  return Promise.resolve('已把主题从 ' + old + ' 切换为 ' + t + '。');
}

function tSetTags(a) {
  var action = String(a.action || 'list');
  if (action === 'list') return loadTags().then(function () { return '当前默认标签清单（' + state.tags.length + ' 个）：' + state.tags.join('、'); });
  var tag = cleanTag(a.tag);
  if (!tag) return Promise.resolve('错误：add/remove 时 tag 必填');
  if (action === 'add') {
    if (state.tags.indexOf(tag) > -1) return Promise.resolve('标签「' + tag + '」已在清单中，无需重复添加。当前清单：' + state.tags.join('、'));
    return aiGate('set_tags', ['新增默认标签：「' + tag + '」'], 1).then(function (ok) {
      if (!ok) return '用户拒绝了本次标签新增。';
      return apiSaveTags(state.tags, 'add', tag).then(function (list) {
        state.tags = list;
        aiRefreshTagsUi();
        return '已添加标签「' + tag + '」。当前清单：' + state.tags.join('、');
      });
    });
  }
  if (action === 'remove') {
    if (state.tags.indexOf(tag) === -1) return Promise.resolve('标签「' + tag + '」不在清单中。当前清单：' + state.tags.join('、'));
    return aiGate('set_tags', ['从默认标签清单移除：「' + tag + '」（笔记上已有的该标签不受影响，但发布页将不再可选）'], 1).then(function (ok) {
      if (!ok) return '用户拒绝了本次标签移除。';
      return apiSaveTags(state.tags, 'remove', tag).then(function (list) {
        state.tags = list;
        aiRefreshTagsUi();
        return '已移除标签「' + tag + '」。当前清单：' + state.tags.join('、');
      });
    });
  }
  return Promise.resolve('错误：action 只能是 list / add / remove');
}

function aiRefreshTagsUi() {
  renderCapChips();
  renderFilter();
  if (typeof renderSettingsTags === 'function') renderSettingsTags();
}

function tSshKeyInfo() {
  return api('GET', '/status').then(function (st) {
    var k = st.key || {};
    if (!k.exists) return '尚未生成 SSH 密钥（仅本机模式不需要）。绑定远端后如需生成/换钥匙，用 ssh_key_rotate 或在设置页操作。';
    var lines = ['SSH 密钥：已生成', '远端：' + (st.remote || '未绑定（仅本机）'), '公钥全文（添加到 Gitee/GitHub 的 SSH Keys 即可同步）：', k.pubKey || '（公钥读取失败）'];
    return lines.join('\n');
  });
}

function tSshKeyRotate() {
  return api('GET', '/status').then(function (st) {
    var warn = st.remote ? ['当前远端：' + st.remote, '警告：旧密钥将立即作废，换钥后同步会失败，直到你把新公钥添加到 Gitee/GitHub。'] : ['当前仅本机使用，无远端依赖，换钥无副作用。'];
    return aiGate('ssh_key_rotate', warn.concat(['操作：删除现有 SSH 密钥并重新生成']), 1).then(function (ok) {
      if (!ok) return '用户拒绝了本次密钥重生成。';
      return api('POST', '/setup/key/rotate').then(function (r) {
        return '已重新生成 SSH 密钥。新公钥：\n' + (r.pubKey || '（读取失败，请在设置页查看）')
          + '\n\n请提醒用户：把上面新公钥完整添加到 Gitee/GitHub 的 SSH Keys，同步才能恢复。';
      });
    });
  });
}

function tSshKeyImport(a) {
  var pk = String(a.private_key || '').trim();
  if (!pk) return Promise.resolve('错误：private_key 必填（OpenSSH 格式私钥全文，含 BEGIN/END 行；须无口令）');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pk)) return Promise.resolve('错误：内容不像 OpenSSH 私钥（缺少 BEGIN PRIVATE KEY 头），请粘贴私钥全文。');
  return aiGate('ssh_key_import', ['操作：用粘贴的私钥覆盖本机 SSH 密钥（' + pk.length + ' 字符）'], 1).then(function (ok) {
    if (!ok) return '用户拒绝了本次私钥导入。';
    return api('POST', '/setup/key/import', { privateKey: pk }).then(function (r) {
      return '私钥已导入，派生公钥：\n' + (r.pubKey || '（读取失败，请在设置页查看）');
    });
  });
}

AI_EXEC.app_info = tAppInfo;
AI_EXEC.set_font_size = tSetFontSize;
AI_EXEC.set_theme = tSetTheme;
AI_EXEC.set_tags = tSetTags;
AI_EXEC.ssh_key_info = tSshKeyInfo;
AI_EXEC.ssh_key_rotate = tSshKeyRotate;
AI_EXEC.ssh_key_import = tSshKeyImport;
AI_EXEC.open_url = tOpenUrl;

/* 用系统默认浏览器打开网页：安卓 WebView 的 window.open 无效（见 745cded），走 location.href
   让 shouldOverrideUrlLoading 收到干净 https 交系统浏览器；其余端 window.open → Electron
   setWindowOpenHandler / 浏览器新标签 */
function tOpenUrl(a) {
  var u = String(a.url || '').trim();
  if (!/^https?:\/\//i.test(u)) return Promise.resolve('错误：url 必须是 http(s) 完整地址，收到：' + aiClip(u, 80));
  var host = u.replace(/^https?:\/\//i, '').split('/')[0];
  return aiGate('open_url', ['在系统浏览器打开：' + u], 1).then(function (ok) {
    if (!ok) return '用户拒绝了本次打开网页。';
    if (/Android/i.test(navigator.userAgent)) location.href = u;
    else window.open(u, '_blank', 'noopener');
    return '已在系统浏览器打开 ' + host + '（若未弹出请检查浏览器窗口是否被遮挡）。';
  });
}

AI_TOOLS.push(
  aiTool('app_info', '查询应用自身信息：应用名、版本与构建、官网、开源地址、运行端、仓库状态、SSH 密钥状态、AI 权限模式。用户问「你自己/这个应用/版本/官网/源码在哪」时必须用它，不要凭空回答。', {}),
  aiTool('set_font_size', '查询或设置正文字号（本机即时生效，10–50px 整数）。不传 size=查询当前值；传 size=设置。', {
    size: { type: 'number', description: '目标字号 10–50 整数；省略=查询当前值' }
  }),
  aiTool('set_theme', '查询或设置界面主题（本机即时生效）。不传 theme=查询当前值；theme 取 light（浅色）/ dark（深色）/ auto（跟随系统）。', {
    theme: { type: 'string', description: 'light / dark / auto；省略=查询当前值' }
  }),
  aiTool('set_tags', '管理默认标签清单（git 持久化、多端同步）。action=list 查看清单；action=add/remove 配合 tag 新增/移除（需用户确认；移除不影响笔记上已有的标签）。新增标签会出现在可用标签清单与发布页可选标签里。', {
    action: { type: 'string', description: 'list / add / remove，默认 list' },
    tag: { type: 'string', description: 'add/remove 时的标签名' }
  }, ['action']),
  aiTool('ssh_key_info', '查看 SSH 同步密钥状态：是否已生成、公钥全文、绑定的远端地址。用户要把公钥添加到 Gitee/GitHub、或排查同步失败时用它。', {}),
  aiTool('ssh_key_rotate', '删除现有 SSH 密钥并重新生成，返回新公钥。旧密钥立即作废：换钥后必须提醒用户把新公钥添加到 Gitee/GitHub 的 SSH Keys，否则多端同步失败。需用户确认。', {}),
  aiTool('ssh_key_import', '导入用户粘贴的 OpenSSH 私钥文本（无口令），覆盖本机密钥并派生公钥。仅在用户明确要求迁移/恢复密钥且粘贴了私钥内容时使用。需用户确认。', {
    private_key: { type: 'string', description: 'OpenSSH 格式私钥全文（含 BEGIN/END 行）' }
  }, ['private_key']),
  aiTool('open_url', '用系统默认浏览器打开网页（离开本应用）。用户说「打开/访问某网页」「帮我把这个链接在浏览器里打开」时使用；仅 http/https。需用户确认。', {
    url: { type: 'string', description: '完整的 http(s) 网页地址' }
  }, ['url'])
);
