/* electron backend 直测：main.json 统一设置 + 钉住（对齐 web api-pin-main-test.js 场景）
   运行：USERPROFILE=<临时目录> node electron-backend-pin-test.js（必须在 electron/ 目录语义下 require backend） */
process.env.USERPROFILE = process.env.ELECTRON_TEST_HOME;
const store = require('../../electron/backend/store.js');
const git = require('../../electron/backend/git.js');
const api = require('../../electron/backend/api.js');
const fs = require('fs');
const path = require('path');
let failed = false;
function assert(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || extra === undefined ? '' : ' | ' + JSON.stringify(extra).slice(0, 200)));
  if (!ok) failed = true;
}
const req = (method, p, body) => api.handleApi(method, p, new URLSearchParams(), body || {});
const mainPath = () => path.join(store.REPO_DIR, 'settings', 'main.json');

(async () => {
  /* 老版本仓库模拟：已有 .git 的旧仓库 + 旧 tags.json/ai.json（无 main.json） */
  const { execSync } = require('child_process');
  fs.mkdirSync(path.join(store.REPO_DIR, '.git'), { recursive: true });
  execSync('git init -q -b main', { cwd: store.REPO_DIR });
  fs.mkdirSync(path.join(store.REPO_DIR, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(store.REPO_DIR, 'settings', 'tags.json'), JSON.stringify(['旧标签A']));
  fs.writeFileSync(path.join(store.REPO_DIR, 'settings', 'ai.json'), JSON.stringify({ baseURL: 'https://old.example/v1', apiKey: 'sk-old', model: 'old-model' }));
  const tg = await req('GET', '/api/tags');
  assert('迁移：GET tags 返回旧标签', tg.status === 200 && tg.payload.tags.indexOf('旧标签A') > -1, tg.payload);
  const m0 = JSON.parse(fs.readFileSync(mainPath(), 'utf8'));
  assert('迁移：main.json version=1 且 ai 收编', m0.version === 1 && m0.ai.apiKey === 'sk-old', m0);

  await req('POST', '/api/setup/local', {});
  const p1 = (await req('POST', '/api/posts', { text: '钉住直测一 EBTEST', tags: [] })).payload;
  await new Promise((s) => setTimeout(s, 1100));
  const p2 = (await req('POST', '/api/posts', { text: '钉住直测二 EBTEST', tags: [] })).payload;
  assert('铺底 2 帖', !!(p1.path && p2.path));

  const pinR = await req('POST', '/api/posts/pin', { path: p2.path, pinned: true });
  assert('pin 200 且含 path', pinR.status === 200 && pinR.payload.indexOf(p2.path) > -1, pinR);
  const feed = (await req('GET', '/api/posts')).payload;
  assert('/api/posts 带 pins', feed.pins.length === 1 && feed.pins[0].path === p2.path, feed.pins);
  const unpinR = await req('POST', '/api/posts/pin', { path: p2.path, pinned: false });
  assert('unpin 200', unpinR.status === 200 && unpinR.payload.indexOf(p2.path) === -1, unpinR);
  assert('main.json 重读无残留', JSON.parse(fs.readFileSync(mainPath(), 'utf8')).pins.length === 0);

  /* 上限：钉满 9（p1 + 8）后第 10 个拒 */
  await req('POST', '/api/posts/pin', { path: p1.path, pinned: true });
  let capOk = true;
  for (let i = 0; i < 8; i++) {
    const pp = (await req('POST', '/api/posts', { text: '批量 EBTEST ' + i, tags: [] })).payload;
    await new Promise((s) => setTimeout(s, 1100));
    const r = await req('POST', '/api/posts/pin', { path: pp.path, pinned: true });
    if (r.status !== 200) capOk = false;
  }
  const pov = (await req('POST', '/api/posts', { text: '超出 EBTEST', tags: [] })).payload;
  const rov = await req('POST', '/api/posts/pin', { path: pov.path, pinned: true });
  assert('上限 9：第 10 个拒绝', capOk && rov.status === 400, { capOk, ov: rov.status });

  /* 删帖清残留 */
  const delR = await req('DELETE', '/api/posts', { path: p1.path });
  assert('删帖后 pins 残留已清', delR.status === 200 && JSON.parse(fs.readFileSync(mainPath(), 'utf8')).pins.indexOf(p1.path) === -1);

  /* tags/ai 走 main.json */
  const addTag = await req('PUT', '/api/tags', { action: 'add', tag: '新标签C' });
  assert('add tag 落 main.json', addTag.status === 200 && JSON.parse(fs.readFileSync(mainPath(), 'utf8')).tags.indexOf('新标签C') > -1);
  const aiSet = await req('POST', '/api/ai/settings', { baseURL: 'https://new.example/v1', apiKey: 'sk-new', model: 'm' });
  assert('set ai 落 main.json', aiSet.status === 200 && JSON.parse(fs.readFileSync(mainPath(), 'utf8')).ai.apiKey === 'sk-new');

  /* 非法路径 */
  const bad = await req('POST', '/api/posts/pin', { path: '../evil.md', pinned: true });
  assert('pin 拒绝非法路径', bad.status === 400, bad.status);

  console.log(failed ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ABORT', e); process.exit(1); });
