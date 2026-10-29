// API 断言：新功能验证（静态拆分文件 / 默认分支 main / 分支 API / 拼音搜索 / 新默认标签）。
// 用法：node web/tools/api-assert.js  （自动以隔离 HOME + GN_PORT=8645 拉起子进程 server.js，测完清理）
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8645;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-test-'));
const BASE = 'http://127.0.0.1:' + PORT;
let cookie = '';
let pass = 0, fail = 0;

function assert(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
async function api(method, url, body) {
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  const r = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

(async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, GN_PORT: String(PORT), USERPROFILE: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (c) => process.stderr.write('[server] ' + c));

  // 等服务起来
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    up = await fetch(BASE + '/healthz').then((r) => r.ok).catch(() => false);
  }
  assert('服务启动', up);

  // 1. 静态拆分：index.html 引用外部 css/js 且 CSP 为 self；静态文件可取
  const html = await fetch(BASE + '/').then((r) => r.text());
  assert('首页引用 /assets/app.css', html.includes('/assets/app.css'));
  assert('首页引用 /js/10-config.js', html.includes('/js/10-config.js'));
  assert('首页无内联 <script> 代码体', !/<script>/.test(html));
  const csp = await fetch(BASE + '/').then((r) => r.headers.get('content-security-policy'));
  assert("CSP script-src 'self'", /script-src 'self'/.test(csp || ''), csp);
  const css = await fetch(BASE + '/assets/app.css');
  assert('app.css 200', css.status === 200 && (css.headers.get('content-type') || '').includes('text/css'));
  const js = await fetch(BASE + '/js/90-events.js');
  assert('js 文件 200', js.status === 200);
  const trav = await fetch(BASE + '/js/..%2Fserver.js');
  assert('目录穿越被拒', trav.status === 404);

  // 2. 仅本机 init：默认分支 main
  await api('GET', '/');   // 领 cookie
  let r = await api('POST', '/api/setup/local', {});
  assert('setup/local 成功', r.status === 200 && r.data.ready);
  r = await api('GET', '/api/status');
  assert('默认分支 main', r.data.branch === 'main', r.data.branch);

  // 3. 默认标签含 想法/感悟
  r = await api('GET', '/api/tags');
  assert('标签含 想法', (r.data.tags || []).includes('想法'), r.data.tags);
  assert('标签含 感悟', (r.data.tags || []).includes('感悟'), r.data.tags);

  // 4. 发帖 + 拼音搜索
  r = await api('POST', '/api/posts', { text: '今天开始用Git笔记记录想法', tags: ['备忘'], images: [] });
  assert('发帖成功', r.status === 200, r.data);
  const p = r.data;
  r = await api('GET', '/api/search?q=' + encodeURIComponent('jintian'));
  assert('全拼搜索 jintian 命中', r.data.hits.some((h) => h.path === p.path), r.data);
  r = await api('GET', '/api/search?q=' + encodeURIComponent('bj'));
  assert('首字母搜索 bj 命中', r.data.hits.some((h) => h.path === p.path), r.data);
  r = await api('GET', '/api/search?q=' + encodeURIComponent('biji'));
  assert('拼音 biji 命中（笔记）', r.data.hits.some((h) => h.path === p.path), r.data);
  r = await api('GET', '/api/search?q=' + encodeURIComponent('Git'));
  assert('原文搜索仍可用', r.data.hits.some((h) => h.path === p.path), r.data);
  r = await api('GET', '/api/search?q=' + encodeURIComponent('buxiangganyule'));
  assert('无关拼音不误命中', !r.data.hits.some((h) => h.path === p.path), r.data);

  // 5. 分支 API：改名 + 非法名拒绝
  r = await api('POST', '/api/branch', { branch: 'dev' });
  assert('分支改名成功', r.status === 200 && r.data.branch === 'dev', r.data);
  r = await api('GET', '/api/status');
  assert('status 反映新分支', r.data.branch === 'dev', r.data.branch);
  r = await api('POST', '/api/branch', { branch: '-bad name' });
  assert('非法分支名 400', r.status === 400, r.status);
  // 发帖后当前分支仍为 dev（写操作不受分支影响）；sleep 1.1s 防同秒发布 409
  await new Promise((r) => setTimeout(r, 1100));
  r = await api('POST', '/api/posts', { text: '分支改名后照常发布', tags: [], images: [] });
  assert('改名后发布正常', r.status === 200, r.data);
  // 改回 main
  r = await api('POST', '/api/branch', { branch: 'main' });
  assert('分支改回 main', r.status === 200 && r.data.branch === 'main', r.data);

  // 清理：杀服务 + 删临时 HOME
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
