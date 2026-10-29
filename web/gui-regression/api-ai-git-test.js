/* /api/git/log|show|restore API 断言（AI 三期 git 工具的服务端）
   前置：隔离环境 web/server.js（GN_PORT=18646 + 临时 HOME）。写后重读断言（项目铁律）。 */
const BASE = 'http://127.0.0.1:18646';
(async () => {
  const results = [];
  const assert = (name, ok, extra) => { results.push((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok || extra === undefined ? '' : ' —— ' + extra)); console.log(results[results.length - 1]); if (!ok) process.exitCode = 1; };
  const cookie = (await fetch(BASE + '/').then(r => r.headers.get('set-cookie') || '')).split(';')[0];
  const api = async (method, p, body) => {
    const r = await fetch(BASE + '/api' + p, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  const st = await api('GET', '/status');
  if (st.data.stage !== 'ready' && st.data.stage !== 'local') await api('POST', '/setup/local', {});

  /* 1) 建帖 → 改帖（产生可追溯的两版历史） */
  const created = await api('POST', '/posts', { text: 'git工具测试：初始版本内容', tags: ['备忘'], ai: 1 });
  assert('建帖成功', created.status === 200 && created.data.path, JSON.stringify(created.data));
  const p = created.data.path;
  await new Promise(r => setTimeout(r, 1100));
  const updated = await api('PUT', '/posts', { path: p, text: 'git工具测试：被 AI 改坏之后的版本', tags: ['备忘'], ai: 1 });
  assert('改帖成功', updated.status === 200, JSON.stringify(updated.data));

  /* 2) git/log：能按 path 过滤出 add 提交，[ai] 标记在列 */
  const log = await api('GET', '/git/log?limit=50&path=' + encodeURIComponent(p));
  assert('git/log 返回该帖提交历史（含 [ai] 标记）', log.status === 200 && log.data.commits.length >= 2 && log.data.commits.every(c => /\[ai\]/.test(c.subject)), JSON.stringify(log.data).slice(0, 200));
  const addCommit = log.data.commits.find(c => c.subject.indexOf('micro: add') === 0);
  assert('git/log 能定位 micro: add 提交', !!addCommit, JSON.stringify(log.data.commits));

  /* 3) git/show：读到 add 时点的旧文本 */
  const show = await api('GET', '/git/show?path=' + encodeURIComponent(p) + '&commit=' + addCommit.hash);
  assert('git/show 读到历史版本全文', show.status === 200 && show.data.text.indexOf('初始版本内容') > -1 && show.data.text.indexOf('被 AI 改坏') === -1, JSON.stringify(show.data).slice(0, 200));

  /* 4) 非法参数被拒：坏 commit / 逃逸 path */
  const badCommit = await api('GET', '/git/show?path=' + encodeURIComponent(p) + '&commit=' + encodeURIComponent('..; rm'));
  assert('git/show 拒绝非法 commit', badCommit.status === 400, 'status=' + badCommit.status);
  const badPath = await api('GET', '/git/log?path=' + encodeURIComponent('../settings/tags.json'));
  assert('git/log 拒绝越界 path', badPath.status === 400, 'status=' + badPath.status);

  /* 5) git/restore：恢复到 add 时点（新提交落地），写后重读 */
  await new Promise(r => setTimeout(r, 1100));
  const restore = await api('POST', '/git/restore', { path: p, commit: addCommit.hash, ai: 1 });
  assert('git/restore 成功', restore.status === 200 && restore.data.restored, JSON.stringify(restore.data));
  const month = p.slice(6, 10) + p.slice(11, 13);
  const page = await api('GET', '/posts?before=' + String(Number(month) + 1));
  const post = (page.data.posts || []).find(x => x.path === p);
  assert('写后重读：正文已恢复为初始版本', !!post && post.text.indexOf('初始版本内容') > -1 && post.text.indexOf('被 AI 改坏') === -1, post && post.text);
  const log2 = await api('GET', '/git/log?limit=3&path=' + encodeURIComponent(p));
  assert('恢复以新提交落地（[ai] 标记）', log2.data.commits[0].subject.indexOf('micro: update') === 0 && /\[ai\]/.test(log2.data.commits[0].subject), JSON.stringify(log2.data.commits[0]));

  /* 6) 清理测试帖 */
  await api('DELETE', '/posts', { path: p, ai: 1 });
  const after = await api('GET', '/posts?before=' + String(Number(month) + 1));
  assert('清理：测试帖已删除', !(after.data.posts || []).some(x => x.path === p));

  console.log('---\n' + results.join('\n'));
})();
