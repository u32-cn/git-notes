/* 分支定死 main（2026-10-31 连接/同步职责分离）API 回归：隔离环境起服务 + 临时 bare 远端。
   覆盖：bindConnect 只登记远端 / 同步时远端无 main → 推送建立 / 远端有 main 无关历史 → 自动合并 /
   同步冲突 → 本地覆盖远端（force push）/ 远端覆盖本地（remote-overwrite）。
   用法：先手工起隔离服务（GN_PORT=18651 + 临时 USERPROFILE），再跑本脚本。 */
const BASE = 'http://127.0.0.1:18651';
const { execSync } = require('child_process');
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
  const seedMain = (tmp, name, tag, file, content) => {
    const remote = path.join(tmp, name + '.git');
    git(['init --bare -b main "' + remote + '"']);
    const seed = path.join(tmp, 'seed-' + name);
    git(['clone -q "' + remote + '" "' + seed + '"']);
    fs.mkdirSync(path.join(seed, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(seed, file), content);
    git(['add .'], seed);
    git(['-c user.name=t -c user.email=t@t commit -m "' + tag + '"'], seed);
    git(['push -q origin main'], seed);
    return remote;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-main-test-'));

  let st = await api('GET', '/status');
  if (st.data.stage !== 'fresh') { console.log('前置：需要全新隔离 HOME，stage=' + st.data.stage); process.exit(2); }
  const setup = await api('POST', '/setup/local', {});
  assert('setupLocal 成功', setup.status === 200, JSON.stringify(setup.data));
  st = await api('GET', '/status');
  assert('status.branch=main（local）', st.data.branch === 'main', JSON.stringify(st.data));

  // 发一帖，保证本地有提交
  const post = await api('POST', '/posts', { text: '主分支测试帖A', tags: ['备忘'] });
  assert('发帖成功', post.status === 200, JSON.stringify(post.data));

  // 场景 A：连接「只有 master」的远端 → 本地立即 ready；同步时推送建立远端 main
  const remoteA = path.join(tmp, 'remoteA.git');
  git(['init --bare -b master "' + remoteA + '"']);
  const seedA = path.join(tmp, 'seedA');
  git(['clone -q "' + remoteA + '" "' + seedA + '"']);
  fs.writeFileSync(path.join(seedA, 'old.txt'), 'old master content');
  git(['add .'], seedA);
  git(['-c user.name=t -c user.email=t@t commit -m "old master"'], seedA);
  git(['push -q origin master'], seedA);

  const connA = await api('POST', '/bind/connect', { remote: remoteA });
  assert('bindConnect 成功（只登记，无网络操作）', connA.status === 200 && connA.data.connected === true, JSON.stringify(connA.data));
  st = await api('GET', '/status');
  assert('连接后 stage=ready', st.data.stage === 'ready', JSON.stringify(st.data));
  assert('连接后 status.branch=main', st.data.branch === 'main', JSON.stringify(st.data));
  const syncA = await api('POST', '/sync', {});
  assert('同步成功且新建远端 main', syncA.status === 200 && syncA.data.created === 'main', JSON.stringify(syncA.data));
  const remoteBranches = git(['ls-remote "' + remoteA + '"']);
  assert('远端已出现 refs/heads/main', /refs\/heads\/main/.test(remoteBranches), remoteBranches.trim());
  assert('远端 master 仍在（未删）', /refs\/heads\/master/.test(remoteBranches), remoteBranches.trim());
  const syncA2 = await api('POST', '/sync', {});
  assert('二次同步 ahead=0 behind=0', syncA2.status === 200 && syncA2.data.ahead === 0 && syncA2.data.behind === 0, JSON.stringify(syncA2.data));

  // 场景 B：解绑 → 连接有独立历史的 main 远端 → 同步时无关历史自动合并
  await api('POST', '/unbind', {});
  const remoteB = seedMain(tmp, 'remoteB', 'remote main', 'b.txt', 'b');
  const connB = await api('POST', '/bind/connect', { remote: remoteB });
  assert('连接 main 远端成功', connB.status === 200 && connB.data.connected === true, JSON.stringify(connB.data));
  const syncB = await api('POST', '/sync', {});
  assert('无关历史自动合并同步干净', syncB.status === 200 && syncB.data.ahead === 0 && syncB.data.behind === 0, JSON.stringify(syncB.data));

  // 场景 C：本地改 settings/main.json，远端（无关历史）也带 settings/main.json → add/add 冲突 → 本地覆盖远端
  await api('POST', '/unbind', {});
  await api('PUT', '/tags', { action: 'add', tag: '冲突测试标签' });
  const remoteC = seedMain(tmp, 'remoteC', 'remote main.json', 'settings/main.json', JSON.stringify({ version: 1, tags: ['远端标签'], pins: [] }));
  await api('POST', '/bind/connect', { remote: remoteC });
  const syncC = await api('POST', '/sync', {});
  assert('同步返回 409 冲突', syncC.status === 409 && Array.isArray(syncC.data.conflict) && syncC.data.conflict.some(f => f.includes('main.json')), JSON.stringify(syncC.data));
  const fpC = await api('POST', '/force-push', {});
  assert('本地覆盖远端（force push）成功', fpC.status === 200, JSON.stringify(fpC.data));
  const syncC2 = await api('POST', '/sync', {});
  assert('覆盖后同步干净', syncC2.status === 200 && syncC2.data.ahead === 0 && syncC2.data.behind === 0, JSON.stringify(syncC2.data));

  // 场景 D：再连一个带不同 main.json 的无关远端 → add/add 冲突 → 远端覆盖本地（remote-overwrite）
  await api('POST', '/unbind', {});
  const remoteD = seedMain(tmp, 'remoteD', 'remoteD main.json', 'settings/main.json', JSON.stringify({ version: 1, tags: ['远端D标签'], pins: [] }));
  await api('POST', '/bind/connect', { remote: remoteD });
  const syncD = await api('POST', '/sync', {});
  assert('同步返回 409 冲突', syncD.status === 409 && Array.isArray(syncD.data.conflict), JSON.stringify(syncD.data));
  if (syncD.status === 409) {
    const roD = await api('POST', '/remote-overwrite', {});
    assert('远端覆盖本地（reset --hard）成功', roD.status === 200 && roD.data.overwritten === true, JSON.stringify(roD.data));
    const syncD2 = await api('POST', '/sync', {});
    assert('覆盖后同步干净', syncD2.status === 200 && syncD2.data.ahead === 0 && syncD2.data.behind === 0, JSON.stringify(syncD2.data));
    const tagsD = await api('GET', '/tags');
    assert('本地 main.json 已被远端内容替换', JSON.stringify(tagsD.data).includes('远端D标签'), JSON.stringify(tagsD.data));
  }

  // /api/branch 已删（404）+ 旧绑定端点已删
  for (const ep of ['/branch', '/bind/probe', '/bind/confirm', '/bind/merge', '/bind/force-push', '/bind/cancel']) {
    const r = await api('POST', ep, {});
    assert('POST ' + ep + ' 已删除（404）', r.status === 404, 'status=' + r.status);
  }

  // git_branch list 仍可用
  const bl = await api('POST', '/git/branch', { action: 'list' });
  assert('git/branch list 正常', bl.status === 200 && bl.data.branches.some(b => b.current && b.name === 'main'), JSON.stringify(bl.data));

  console.log('---'); console.log(results.filter(r => r.startsWith('FAIL')).length + ' failed / ' + results.length + ' total');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
})();
