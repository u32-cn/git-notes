/* AI 全量文件操作 + git 工具的服务端 API 断言（fs_* 6 端点 + git_* 8 端点）
   前置：隔离环境 web/server.js（GN_PORT=18648 + 临时 HOME）。写后重读断言（项目铁律）。
   覆盖：路径红线（../、.git、绝对路径）/ fs 读写删移建 / 覆盖备份 / git status-add-commit-diff / 分支 / restore-files。 */
const BASE = 'http://127.0.0.1:18648';
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
  /* 铺底一帖：让当前月 micro/YYYY/MM 目录被 git 跟踪，后续手动文件不会被折叠成 ?? micro/ */
  const now = new Date();
  const MONTH_DIR = 'micro/' + now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
  const base = await api('POST', '/posts', { text: '铺底帖子：让 micro 目录被跟踪', tags: ['备忘'] });
  assert('铺底帖发布', base.status === 200 && base.data.path.indexOf(MONTH_DIR) === 0, JSON.stringify(base.data));

  /* ===== 路径红线 ===== */
  const t1 = await api('GET', '/fs/read?path=' + encodeURIComponent('../secrets.txt'));
  assert('fs/read 拒绝 .. 逃逸', t1.status === 400, 'status=' + t1.status);
  const t2 = await api('GET', '/fs/read?path=' + encodeURIComponent('.git/config'));
  assert('fs/read 拒绝 .git', t2.status === 400, 'status=' + t2.status);
  const t3 = await api('GET', '/fs/read?path=' + encodeURIComponent('C:/Windows/win.ini'));
  assert('fs/read 拒绝绝对路径', t3.status === 400, 'status=' + t3.status);
  const t4 = await api('POST', '/fs/write', { path: 'a/../../evil.txt', content: 'x' });
  assert('fs/write 拒绝内嵌 ..', t4.status === 400, 'status=' + t4.status);

  /* ===== fs write → read → list → move → delete（写后重读） ===== */
  const w = await api('POST', '/fs/write', { path: 'notes-demo/hello.md', content: '# 你好\nAI 写入的内容' });
  assert('fs/write 创建文件（自动建父目录）', w.status === 200 && w.data.path === 'notes-demo/hello.md' && w.data.size > 0, JSON.stringify(w.data));
  const r1 = await api('GET', '/fs/read?path=' + encodeURIComponent('notes-demo/hello.md'));
  assert('写后重读：内容一致', r1.status === 200 && r1.data.encoding === 'text' && r1.data.content.indexOf('你好') > -1, JSON.stringify(r1.data).slice(0, 150));
  const w2 = await api('POST', '/fs/write', { path: 'notes-demo/hello.md', content: '覆盖后的内容' });
  assert('fs/write 覆盖已存在文件且报备份', w2.status === 200 && w2.data.overwrote === true && w2.data.backup === true, JSON.stringify(w2.data));
  const bin = await api('POST', '/fs/write', { path: 'notes-demo/blob.bin', content: Buffer.from([1, 2, 0, 3]).toString('base64'), encoding: 'base64' });
  assert('fs/write base64 二进制', bin.status === 200 && bin.data.size === 4, JSON.stringify(bin.data));
  const rb = await api('GET', '/fs/read?path=' + encodeURIComponent('notes-demo/blob.bin'));
  assert('二进制读回 base64', rb.status === 200 && rb.data.encoding === 'base64', JSON.stringify(rb.data).slice(0, 120));
  const ls = await api('GET', '/fs/list?path=' + encodeURIComponent('notes-demo'));
  assert('fs/list 列出目录内容', ls.status === 200 && ls.data.count === 2 && ls.data.entries.every(e => e.type === 'file'), JSON.stringify(ls.data));
  const lsRoot = await api('GET', '/fs/list');
  assert('fs/list 根目录含 micro/settings/notes-demo', lsRoot.status === 200 && ['micro', 'settings', 'notes-demo'].every(n => lsRoot.data.entries.some(e => e.name === n)), JSON.stringify(lsRoot.data).slice(0, 200));
  const mv = await api('POST', '/fs/move', { from: 'notes-demo/hello.md', to: 'notes-demo/hello2.md' });
  assert('fs/move 重命名', mv.status === 200 && mv.data.to === 'notes-demo/hello2.md', JSON.stringify(mv.data));
  const mvDup = await api('POST', '/fs/move', { from: 'notes-demo/hello2.md', to: 'notes-demo/blob.bin' });
  assert('fs/move 目标已存在被拒', mvDup.status === 409, 'status=' + mvDup.status);
  const mk = await api('POST', '/fs/mkdir', { path: 'notes-demo/sub' });
  assert('fs/mkdir 建目录', mk.status === 200, JSON.stringify(mk.data));
  const delDir = await api('POST', '/fs/delete', { paths: ['notes-demo'] });
  assert('fs/delete 拒绝非空目录', delDir.status === 200 && delDir.data.results[0].error, JSON.stringify(delDir.data));
  const del = await api('POST', '/fs/delete', { paths: ['notes-demo/hello2.md', 'notes-demo/blob.bin', 'notes-demo/sub', 'notes-demo/不存在.md'] });
  const delOk = del.data.results.filter(x => x.deleted).length;
  assert('fs/delete 批量删除（3 成 1 报不存在）', del.status === 200 && delOk === 3 && del.data.results[3].error === '不存在', JSON.stringify(del.data));

  /* ===== git status / add / commit / diff ===== */
  const w3 = await api('POST', '/fs/write', { path: MONTH_DIR + '/manual-note.md', content: '---\ntype: micro\ntags: ["备忘"]\ncreated: "20000101 000000"\n---\n\n手动改的笔记，请 AI 提交' });
  assert('模拟用户手动放入文件', w3.status === 200, JSON.stringify(w3.data));
  const s1 = await api('GET', '/git/status');
  assert('git/status 看到未跟踪文件', s1.status === 200 && s1.data.branch === 'main' && s1.data.entries.some(e => e.y === '?' && e.path.indexOf('manual-note.md') > -1), JSON.stringify(s1.data).slice(0, 200));
  const add = await api('POST', '/git/add', { paths: [MONTH_DIR + '/manual-note.md'] });
  assert('git/add 暂存显式路径', add.status === 200 && add.data.stagedCount === 1, JSON.stringify(add.data));
  const cm0 = await api('POST', '/git/commit', { message: 'micro: add 手动笔记' });
  assert('git/commit 提交成功', cm0.status === 200 && cm0.data.committed && cm0.data.hash, JSON.stringify(cm0.data));
  const cmEmpty = await api('POST', '/git/commit', { message: '空提交应失败' });
  assert('git/commit 空暂存区被拒', cmEmpty.status === 400, 'status=' + cmEmpty.status);
  const s2 = await api('GET', '/git/status');
  assert('提交后工作区干净', s2.status === 200 && s2.data.clean === true, JSON.stringify(s2.data));
  const df = await api('GET', '/git/diff?from=' + encodeURIComponent('HEAD~1') + '&to=HEAD');
  assert('git/diff 两提交间差异', df.status === 200 && df.data.text.indexOf('manual-note') > -1, (df.data.text || '').slice(0, 120));
  const dfPath = await api('GET', '/git/diff?from=' + encodeURIComponent('HEAD~1') + '&to=HEAD&path=' + encodeURIComponent('settings/tags.json'));
  assert('git/diff path 过滤后为空', dfPath.status === 200 && !dfPath.data.text.trim(), JSON.stringify(dfPath.data).slice(0, 120));
  const dfStat = await api('GET', '/git/diff?mode=stat&from=' + encodeURIComponent('HEAD~1') + '&to=HEAD');
  assert('git/diff stat 模式', dfStat.status === 200 && dfStat.data.text.indexOf('|') > -1, (dfStat.data.text || '').slice(0, 120));

  /* ===== git branch（2026-10-27 分支定死 main：只剩 list；create/switch 端点已删） ===== */
  const bl = await api('POST', '/git/branch', { action: 'list' });
  assert('git/branch list', bl.status === 200 && bl.data.branches.some(b => b.current), JSON.stringify(bl.data));
  const bc = await api('POST', '/git/branch', { action: 'create', name: 'ai-test-branch' });
  assert('git/branch create 已删（仍返回 list）', bc.status === 200 && Array.isArray(bc.data.branches), JSON.stringify(bc.data));

  /* ===== git restore-files：删文件并提交删除 → 从历史找回（工作区+暂存）→ 再提交 ===== */
  const delPost = await api('POST', '/fs/delete', { paths: [MONTH_DIR + '/manual-note.md'] });
  assert('删除文件准备恢复场景', delPost.status === 200, JSON.stringify(delPost.data));
  await api('POST', '/git/add', { paths: [MONTH_DIR + '/manual-note.md'] });
  await api('POST', '/git/commit', { message: 'micro: delete 手动笔记' });
  const log = await api('GET', '/git/log?limit=5');
  const hasManual = log.data.commits.find(c => c.subject.indexOf('micro: add 手动笔记') === 0);
  assert('git/log 看到手动提交', !!hasManual, JSON.stringify(log.data.commits).slice(0, 200));
  const rf = await api('POST', '/git/restore-files', { commit: hasManual.hash, paths: [MONTH_DIR + '/manual-note.md'] });
  assert('git/restore-files 找回被删文件', rf.status === 200 && rf.data.restored.length === 1, JSON.stringify(rf.data));
  const reread = await api('GET', '/fs/read?path=' + encodeURIComponent(MONTH_DIR + '/manual-note.md'));
  assert('写后重读：恢复内容一致', reread.status === 200 && reread.data.content.indexOf('手动改的笔记') > -1, JSON.stringify(reread.data).slice(0, 150));
  const rfBad = await api('POST', '/git/restore-files', { commit: hasManual.hash, paths: ['.git/config'] });
  assert('restore-files 拒绝 .git 路径', rfBad.status === 400, 'status=' + rfBad.status);
  const cm2 = await api('POST', '/git/commit', { message: 'micro: update 找回手动笔记' });
  assert('找回后可提交', cm2.status === 200 && cm2.data.committed, JSON.stringify(cm2.data));

  /* ===== push/pull：仅本机模式应被拒 ===== */
  const gp = await api('POST', '/git/push', {});
  assert('仅本机模式 git/push 被拒', gp.status === 409, 'status=' + gp.status);
  const gl = await api('POST', '/git/pull', {});
  assert('仅本机模式 git/pull 被拒', gl.status === 409, 'status=' + gl.status);

  /* ===== 清理测试文件 ===== */
  await api('POST', '/fs/delete', { paths: [MONTH_DIR + '/manual-note.md', MONTH_DIR, MONTH_DIR.split('/').slice(0, 2).join('/')] });
  const s3 = await api('GET', '/git/status');
  if (!s3.data.clean) {
    await api('POST', '/git/add', { paths: s3.data.entries.map(e => e.path) });
    await api('POST', '/git/commit', { message: 'fs: cleanup 测试残留' });
  }
  const s4 = await api('GET', '/git/status');
  assert('清理后工作区干净', s4.data.clean === true, JSON.stringify(s4.data));

  console.log('---\n' + results.join('\n'));
})();
