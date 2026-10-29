/* 钉住（settings/main.json）+ 统一设置迁移 API 断言
   前置：隔离环境 web/server.js（GN_PORT=18649 + 临时 HOME）。写后重读断言（项目铁律）。
   覆盖：旧 tags.json/ai.json 一次性收编进 main.json / pin·unpin 写后重读 /
         /api/posts 响应带 pins / 上限 9 / 删帖清残留 / tags·ai 设置读写指向 main.json。 */
const BASE = 'http://127.0.0.1:18649';
const fs = require('fs');
const path = require('path');
const os = require('os');
const REPO = path.join(process.env.GN_TEST_HOME || path.join(os.tmpdir(), 'gn-pin-test'), '.git-notes', 'repo');
let failed = false;
function assert(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || extra === undefined ? '' : ' | ' + JSON.stringify(extra).slice(0, 300)));
  if (!ok) failed = true;
}
let cookie = '';
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}
const mainPath = () => path.join(REPO, 'settings', 'main.json');
const readMainRaw = () => JSON.parse(fs.readFileSync(mainPath(), 'utf8'));

(async () => {
  await api('GET', '/');

  /* ===== 迁移：初始化后模拟老版本仓库（旧 tags.json/ai.json、无 main.json），GET tags 触发收编 ===== */
  const su = await api('POST', '/api/setup/local', {});
  assert('setup/local 成功', su.status === 200, su);
  fs.mkdirSync(path.join(REPO, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'settings', 'tags.json'), JSON.stringify(['旧标签A', '旧标签B']));
  fs.writeFileSync(path.join(REPO, 'settings', 'ai.json'), JSON.stringify({ baseURL: 'https://old.example/v1', apiKey: 'sk-old', model: 'old-model' }));
  fs.rmSync(mainPath());
  const tg = await api('GET', '/api/tags');
  assert('迁移：GET tags 返回旧标签', tg.status === 200 && tg.json.tags.indexOf('旧标签A') > -1 && tg.json.tags.indexOf('旧标签B') > -1, tg.json);
  const m0 = readMainRaw();
  assert('迁移：main.json 已生成 version=1', m0.version === 1, m0);
  assert('迁移：tags 收编', Array.isArray(m0.tags) && m0.tags.indexOf('旧标签A') > -1, m0.tags);
  assert('迁移：ai 收编', m0.ai && m0.ai.baseURL === 'https://old.example/v1' && m0.ai.apiKey === 'sk-old', m0.ai);
  assert('迁移：pins 默认空数组', Array.isArray(m0.pins) && m0.pins.length === 0, m0.pins);

  /* ===== 铺底 3 帖（间隔 >1s 防同秒 409） ===== */
  const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
  const mk = async (t) => { const r = await api('POST', '/api/posts', { text: t, tags: [] }); await sleep(1100); return r; };
  const p1 = (await mk('钉住测试一 PINTEST ' + Date.now())).json;
  const p2 = (await mk('钉住测试二 PINTEST')).json;
  const p3 = (await mk('普通帖 PINTEST')).json;
  assert('铺底 3 帖成功', !!(p1.path && p2.path && p3.path));

  /* ===== pin 写后重读 ===== */
  const pinR = await api('POST', '/api/posts/pin', { path: p2.path, pinned: true });
  assert('pin 返回 200', pinR.status === 200, pinR);
  assert('pin 响应含该 path', pinR.json.indexOf(p2.path) > -1, pinR.json);
  assert('main.json pins 写后重读', readMainRaw().pins.indexOf(p2.path) > -1, readMainRaw().pins);
  const feed1 = await api('GET', '/api/posts');
  assert('/api/posts 响应带 pins 且含钉住帖', Array.isArray(feed1.json.pins) && feed1.json.pins.some((p) => p.path === p2.path), feed1.json.pins);

  /* 再钉一帖（响应顺序：p1 更新） */
  await api('POST', '/api/posts/pin', { path: p1.path, pinned: true });
  const feed2 = await api('GET', '/api/posts');
  assert('两个钉住帖都在响应里', feed2.json.pins.length === 2 && feed2.json.pins.some((p) => p.path === p1.path), feed2.json.pins.map((p) => p.path));

  /* ===== unpin 写后重读 ===== */
  const unpinR = await api('POST', '/api/posts/pin', { path: p2.path, pinned: false });
  assert('unpin 返回 200 且清单移除', unpinR.status === 200 && unpinR.json.indexOf(p2.path) === -1, unpinR.json);
  assert('unpin 后 main.json 重读无残留', readMainRaw().pins.indexOf(p2.path) === -1, readMainRaw().pins);

  /* ===== 上限 9（p1 占 1 席，再成功 8 个，第 10 个拒绝） ===== */
  let capOk = true;
  for (let i = 0; i < 8; i++) {
    const pp = (await mk('批量钉住 PINTEST ' + i)).json;
    const r = await api('POST', '/api/posts/pin', { path: pp.path, pinned: true });
    if (r.status !== 200) capOk = false;
  }
  const pover = (await mk('超出上限 PINTEST')).json;
  const rov = await api('POST', '/api/posts/pin', { path: pover.path, pinned: true });
  assert('上限 9：第 10 个拒绝', capOk && rov.status === 400, { capOk, ov: rov.status });
  assert('上限 9：main.json 仍是 9 个', readMainRaw().pins.length === 9, readMainRaw().pins.length);

  /* ===== 删帖清残留 ===== */
  const delR = await api('DELETE', '/api/posts', { path: p1.path });
  assert('删帖 200', delR.status === 200, delR);
  assert('删帖后 pins 残留已清', readMainRaw().pins.indexOf(p1.path) === -1, readMainRaw().pins);

  /* ===== tags/ai 设置继续走 main.json ===== */
  const addTag = await api('PUT', '/api/tags', { action: 'add', tag: '新标签C' });
  assert('add tag 200', addTag.status === 200 && addTag.json.indexOf('新标签C') > -1, addTag.json);
  assert('add tag 落在 main.json', readMainRaw().tags.indexOf('新标签C') > -1, readMainRaw().tags);
  const aiSet = await api('POST', '/api/ai/settings', { baseURL: 'https://new.example/v1', apiKey: 'sk-new', model: 'new-model' });
  assert('set ai 200', aiSet.status === 200 && aiSet.json.apiKey === 'sk-new', aiSet.json);
  assert('ai 落在 main.json', readMainRaw().ai.model === 'new-model', readMainRaw().ai);
  const aiGet = await api('GET', '/api/ai/settings');
  assert('get ai 读 main.json', aiGet.json.baseURL === 'https://new.example/v1', aiGet.json);

  /* ===== pin 非法路径拒绝 ===== */
  const bad = await api('POST', '/api/posts/pin', { path: '../evil.md', pinned: true });
  assert('pin 拒绝非法路径', bad.status === 400, bad.status);

  console.log(failed ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ABORT', e); process.exit(1); });
