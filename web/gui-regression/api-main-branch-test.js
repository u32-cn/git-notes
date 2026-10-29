/* 分支定死 main（2026-10-27）API 回归：隔离环境起服务 + 临时 bare 远端。
   覆盖：setupLocal 落 main / 绑定「只有 master」的远端 → 推送建立 origin/main /
   绑定 main 远端正常 / /api/branch 已删 / status.branch 恒 main / doSync 正常。
   用法：先手工起隔离服务（GN_PORT=18651 + 临时 USERPROFILE），再跑本脚本。 */
const BASE = 'http://127.0.0.1:18651';
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const results = [];
  const assert = (name, ok, extra) => { results.push((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok || extra === undefined ? '' : ' —— ' + extra)); console.log(results[results.length - 1]); if (!ok) process.exitCode = 1; };
  const cookie = (await fetch(BASE + '/').then(r => r.headers.get('set-cookie') || '')).split(';')[0];
  const api = async (method, p, body) => {
    const r = await fetch(BASE + '/api' + p, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const git = (args, cwd) => execSync('git ' + args, { cwd, env: process.env }).toString();

  // 场景 A：本地 init → 绑定只有 master 的 bare 远端 → 应推本地 main 建立远端 main
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-main-test-'));
  const remoteA = path.join(tmp, 'remoteA.git');
  git(['init --bare -b master "' + remoteA + '"']);
  // 先在远端造一条 master 提交（真正的「只有 master」仓库）
  const seedA = path.join(tmp, 'seedA');
  git(['clone -q "' + remoteA + '" "' + seedA + '"']);
  fs.writeFileSync(path.join(seedA, 'old.txt'), 'old master content');
  git(['add .'], seedA);
  git(['-c user.name=t -c user.email=t@t commit -m "old master"'], seedA);
  git(['push -q origin master'], seedA);

  let st = await api('GET', '/status');
  if (st.data.stage !== 'fresh') { console.log('前置：需要全新隔离 HOME，stage=' + st.data.stage); process.exit(2); }
  const setup = await api('POST', '/setup/local', {});
  assert('setupLocal 成功', setup.status === 200, JSON.stringify(setup.data));
  st = await api('GET', '/status');
  assert('status.branch=main（local）', st.data.branch === 'main', JSON.stringify(st.data));

  // 发一帖，保证本地有提交
  const post = await api('POST', '/posts', { text: '主分支测试帖A', tags: ['备忘'] });
  assert('发帖成功', post.status === 200, JSON.stringify(post.data));

  const probeA = await api('POST', '/bind/probe', { remote: remoteA });
  assert('bindProbe：非空仓、无 branch 字段', probeA.status === 200 && probeA.data.empty === false && probeA.data.branch === undefined, JSON.stringify(probeA.data));
  const bindA = await api('POST', '/bind/confirm', { remote: remoteA });
  assert('绑定 master 远端：推送建立 main', bindA.status === 200 && bindA.data.mode === 'empty-remote-pushed', JSON.stringify(bindA.data));
  const remoteBranches = git(['ls-remote "' + remoteA + '"']);
  assert('远端已出现 refs/heads/main', /refs\/heads\/main/.test(remoteBranches), remoteBranches.trim());
  assert('远端 master 仍在（未删）', /refs\/heads\/master/.test(remoteBranches), remoteBranches.trim());
  st = await api('GET', '/status');
  assert('status.branch=main（ready）', st.data.branch === 'main', JSON.stringify(st.data));
  const syncA = await api('POST', '/sync', {});
  assert('同步 ahead=0 behind=0', syncA.status === 200 && syncA.data.ahead === 0 && syncA.data.behind === 0, JSON.stringify(syncA.data));

  // 解绑 → 场景 B：绑定 main 远端（本地已有历史 + 远端有历史 → pendingMerge 分支名恒 main）
  await api('POST', '/unbind', {});
  const remoteB = path.join(tmp, 'remoteB.git');
  git(['init --bare -b main "' + remoteB + '"']);
  const seedB = path.join(tmp, 'seedB');
  git(['clone -q "' + remoteB + '" "' + seedB + '"']);
  fs.writeFileSync(path.join(seedB, 'b.txt'), 'b');
  git(['add .'], seedB);
  git(['-c user.name=t -c user.email=t@t commit -m "remote main"'], seedB);
  git(['push -q origin main'], seedB);
  const bindB = await api('POST', '/bind/confirm', { remote: remoteB });
  assert('绑定 main 远端：pendingMerge 且 branch=main', bindB.status === 200 && bindB.data.pendingMerge === true && bindB.data.branch === 'main', JSON.stringify(bindB.data));
  const mergeB = await api('POST', '/bind/merge', {});
  assert('bindMerge 成功', mergeB.status === 200 && mergeB.data.mode === 'merged', JSON.stringify(mergeB.data));
  const syncB = await api('POST', '/sync', {});
  assert('合并后同步干净', syncB.status === 200 && syncB.data.ahead === 0 && syncB.data.behind === 0, JSON.stringify(syncB.data));

  // /api/branch 已删（404）
  const oldEp = await api('POST', '/branch', { branch: 'master' });
  assert('/api/branch 已删除', oldEp.status === 404, 'status=' + oldEp.status);

  // git_branch list 仍可用
  const bl = await api('POST', '/git/branch', { action: 'list' });
  assert('git/branch list 正常', bl.status === 200 && bl.data.branches.some(b => b.current && b.name === 'main'), JSON.stringify(bl.data));

  console.log('---'); console.log(results.filter(r => r.startsWith('FAIL')).length + ' failed / ' + results.length + ' total');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
})();
