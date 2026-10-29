/* 附件（files:）API 层断言：发布带附件→写后重读→media 头→编辑增删→删除随删→限额 4xx
   运行前需服务已启动（node web/server.js 或 git-notes）。测试帖用固定前缀，删除走 API（git 提交落地）。 */
const BASE = 'http://127.0.0.1:8644';
let cookie = '';
let failed = false;
function assert(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || extra === undefined ? '' : ' | ' + JSON.stringify(extra).slice(0, 300)));
  if (!ok) failed = true;
}
async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json, headers: res.headers };
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
async function feedFind(prefix) {
  let before = '';
  for (;;) {
    const r = await api('GET', '/api/posts' + (before ? '?before=' + encodeURIComponent(before) : ''));
    const posts = (r.json && r.json.posts) || [];
    const hit = posts.find((p) => (p.text || '').indexOf(prefix) > -1);
    if (hit) return hit;
    if (!posts.length || !r.json.more) return null;
    before = posts[posts.length - 1].path;
  }
}

(async () => {
  const PREFIX = '附件测试-APITEST';
  // 0) 领 cookie
  await api('GET', '/');
  const st = (await api('GET', '/api/status')).json;
  if (!st || st.stage === 'fresh') { console.log('SKIP 未初始化（fresh）'); return; }

  // 清理历史残留测试帖
  const stale = await feedFind(PREFIX);
  if (stale) await api('DELETE', '/api/posts', { path: stale.path });

  // 1) 发布：中文附件名 + 内容校验
  const content = '附件内容测试 ' + Date.now();
  let r = await api('POST', '/api/posts', {
    text: PREFIX + ' 带附件帖',
    tags: [],
    files: [
      { name: '测试文档.txt', ext: 'txt', base64: b64(content) },
      { name: '页面.html', ext: 'html', base64: b64('<script>alert(1)</script>') },
    ],
  });
  assert('发布带 2 附件返回 200', r.status === 200, r.json);
  const post = r.json;
  assert('响应 files 保留原始名', post.files && post.files.length === 2 && post.files[0].name === '测试文档.txt', post.files);
  assert('磁盘名为 stem-fN.ext 形态', /-f[12]\.txt$/.test(post.files[0].path) && /-f[12]\.html$/.test(post.files[1].path), post.files);

  // 2) 写后重读：md files 键与 原名|磁盘名 条目存活
  await new Promise((s) => setTimeout(s, 500));
  const back = await feedFind(PREFIX);
  assert('写后重读命中测试帖', !!back, 'feed 中未找到');
  assert('重读 files 两条且原始名存活', back && back.files && back.files.length === 2 && back.files[0].name === '测试文档.txt', back && back.files);

  // 3) /media 头：txt → attachment + nosniff；html → octet-stream + attachment（防 XSS）；图片 → 内联
  const m1 = await fetch(BASE + '/media/' + encodeURIComponent(back.dir + '/' + back.files[0].path), { headers: { cookie } });
  assert('txt 附件 200', m1.status === 200);
  assert('txt Content-Disposition attachment', /attachment/i.test(m1.headers.get('content-disposition') || ''), m1.headers.get('content-disposition'));
  assert('nosniff 头存在', m1.headers.get('x-content-type-options') === 'nosniff');
  assert('txt 内容完整', (await m1.text()) === content);
  const m2 = await fetch(BASE + '/media/' + encodeURIComponent(back.dir + '/' + back.files[1].path), { headers: { cookie } });
  assert('html 附件为 octet-stream + attachment（防同源执行）',
    m2.headers.get('content-type') === 'application/octet-stream' && /attachment/i.test(m2.headers.get('content-disposition') || ''),
    { ct: m2.headers.get('content-type'), cd: m2.headers.get('content-disposition') });
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let ri = await api('POST', '/api/posts', { text: '图片对照-APITEST', tags: [], images: [{ ext: 'png', base64: png1x1 }] });
  const ipost = ri.json;
  const mi = await fetch(BASE + '/media/' + encodeURIComponent(ipost.dir + '/' + ipost.images[0]), { headers: { cookie } });
  assert('图片仍内联（无 attachment）', mi.status === 200 && !/attachment/i.test(mi.headers.get('content-disposition') || ''), mi.headers.get('content-disposition'));

  // 4) 编辑：删第一个附件 + 新增 pdf，图片保留
  r = await api('PUT', '/api/posts', {
    path: back.path, text: back.text, tags: back.tags,
    keepNames: back.images,
    keepFileNames: [back.files[1].path],
    newFiles: [{ name: '说明.pdf', ext: 'pdf', base64: b64('%PDF-1.4 test') }],
  });
  assert('编辑返回 200 且 files=2', r.status === 200 && r.json.files.length === 2, r.json.files);
  assert('新附件序号接续 -f3', r.json.files[1].path.endsWith('-f3.pdf'), r.json.files);
  await new Promise((s) => setTimeout(s, 500));
  const back2 = await feedFind(PREFIX);
  assert('编辑后重读：txt 已删、pdf 原始名存活',
    back2.files.length === 2 && back2.files[1].name === '说明.pdf' && back2.files.every((f) => f.path !== back.files[0].path), back2.files);
  const gone = await fetch(BASE + '/media/' + encodeURIComponent(back.dir + '/' + back.files[0].path), { headers: { cookie } });
  assert('被删附件 media 404', gone.status === 404, gone.status);

  // 5) 限额：11MB 拒绝、10 个拒绝、非法扩展名拒绝
  const big = Buffer.alloc(11 * 1024 * 1024, 65).toString('base64');
  r = await api('POST', '/api/posts', { text: 'x', tags: [], files: [{ name: 'big.bin', ext: 'bin', base64: big }] });
  assert('11MB 附件 400', r.status === 400, r.status);
  r = await api('POST', '/api/posts', { text: 'x', tags: [], files: Array.from({ length: 10 }, (_, i) => ({ name: 'f' + i + '.txt', ext: 'txt', base64: b64('x') })) });
  assert('10 个附件 400', r.status === 400, r.status);
  r = await api('POST', '/api/posts', { text: 'x', tags: [], files: [{ name: 'a.txt', ext: '../evil', base64: b64('x') }] });
  assert('非法扩展名 400', r.status === 400, r.status);

  // 6) 删除测试帖，附件随删
  await api('DELETE', '/api/posts', { path: ipost.path });
  r = await api('DELETE', '/api/posts', { path: back2.path });
  assert('删除测试帖 200', r.status === 200, r.json);
  await new Promise((s) => setTimeout(s, 500));
  const mdia = await fetch(BASE + '/media/' + encodeURIComponent(back2.dir + '/' + back2.files[0].path), { headers: { cookie } });
  assert('删除后附件 media 404', mdia.status === 404, mdia.status);
  assert('信息流已无测试帖', !(await feedFind(PREFIX)), '残留');

  console.log(failed ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ABORT', e); process.exit(1); });
