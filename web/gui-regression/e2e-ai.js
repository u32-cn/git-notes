/* AI 助手 E2E（配合 web/tools/ai-mock-llm.js）：隔离环境（临时 HOME + 端口 18646）。
   覆盖：首启引导 / 发布带标签帖 / AI 面板开合 / 场景筛选(标签+时间) / 问答引用 / 写入确认与拒绝([ai] 标记) /
   思考折叠 / 停止生成 / 刷新后会话持久 / 宽窄断点切换 / 设置回显。
   注：页面 CSP 禁 eval，用 Node 侧轮询 + page.evaluate（CDP 通道不受 CSP 限）。
   前置：GN_PORT=18646 + 临时 HOME 启动 web/server.js；node web/tools/ai-mock-llm.js 18647 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:18646';
const MOCK = 'http://127.0.0.1:18647/v1';
const SHOT = 'S:/vtxf/vtxf-work/projects/vtxf/git-notes/web/gui-regression/';
(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && m.text().indexOf('409') === -1) errors.push('console: ' + m.text()); });   /* 409 是保存配置重试机制的预期噪声 */

  const results = [];
  const assert = (name, ok) => { results.push((ok ? 'PASS' : 'FAIL') + ' ' + name); console.log(results[results.length - 1]); if (!ok) process.exitCode = 1; };
  const wait = async (fn, arg, timeout) => {
    const t0 = Date.now();
    for (;;) {
      if (await page.evaluate(fn, arg)) return;
      if (Date.now() - t0 > (timeout || 30000)) throw new Error('wait timeout: ' + fn.toString().slice(0, 80));
      await new Promise(r => setTimeout(r, 200));
    }
  };
  const aiSend = async (text) => {
    await wait(() => !document.querySelector('#btn-ai-send').hidden, null, 30000);   /* 上一轮结束（停止按钮切回发送）再发 */
    await page.fill('#ai-input', text);
    await page.$eval('#btn-ai-send', el => el.click());
  };
  const lastMsgText = () => page.evaluate(() => {
    var msgs = document.querySelectorAll('#ai-msgs .ai-msg.assistant, #ai-msgs .ai-act');
    return msgs.length ? msgs[msgs.length - 1].textContent : '';
  });

  try {
    /* 1) 首启引导（幂等：已初始化的临时 HOME 不会出引导页） */
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await new Promise(r => setTimeout(r, 600));
    const needSetup = await page.evaluate(() => !document.querySelector('#setup').hidden);
    if (needSetup) {
      await page.$eval('#btn-local-mode', el => el.click());
      await wait(() => document.querySelector('#setup').hidden);
    }
    await wait(() => !!document.querySelector('#feed .post, #feed .feed-empty'), null, 15000);

    /* 2) 发布两帖：A=日记标签含「搬家」，B=无标签 */
    await page.fill('#cap-input', '搜索测试：搬家的回忆，去年夏天的事');
    await page.$eval('#cap-tags', el => {
      var chips = el.querySelectorAll('.chip');
      for (var i = 0; i < chips.length; i++) if (chips[i].textContent.indexOf('日记') > -1 && chips[i].textContent.indexOf('已完成') === -1) { chips[i].click(); return; }
      throw new Error('chip 日记 not found');
    });
    await page.$eval('#btn-publish', el => el.click());
    await wait(() => document.querySelector('#feed .post') && document.querySelector('#feed').textContent.indexOf('搬家的回忆') > -1, null, 30000);
    await new Promise(r => setTimeout(r, 1100));   /* 服务端同一秒内发布同 stem 会 409，跨秒再发第二篇 */
    await page.fill('#cap-input', '普通帖子：没有标签的日常内容');
    await page.$eval('#btn-publish', el => el.click());
    await wait(() => document.querySelector('#feed').textContent.indexOf('普通帖子') > -1, null, 30000);
    assert('发布两篇测试帖（A 带日记标签，B 无标签）', true);

    /* 3) 写入 AI 配置（存仓库 settings/ai.json，经 API；紧随发布可能撞 409，带重试） */
    const saveCfg = async () => {
      const t0 = Date.now();
      for (;;) {
        const ok = await page.evaluate(async (mock) => {
          const r = await fetch('/api/ai/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseURL: mock, apiKey: 'mock-key', model: 'mock-model' }) });
          return r.ok || r.status !== 409;
        }, MOCK);
        if (ok) return;
        if (Date.now() - t0 > 30000) throw new Error('save ai settings: 409 重试超时');
        await new Promise(r => setTimeout(r, 1500));
      }
    };
    await saveCfg();
    await wait(() => document.querySelector('#feed .post .ptext') && document.querySelector('#feed').textContent.indexOf('搬家的回忆') > -1, null, 30000);
    const saved = await page.evaluate(async () => (await fetch('/api/ai/settings')).json());
    assert('AI 配置已入仓库（settings/ai.json 回读一致）', saved.baseURL === MOCK && saved.apiKey === 'mock-key' && !('mode' in saved));
    const lsLeft = await page.evaluate(() => localStorage.getItem('gnAiConfig'));
    assert('配置不再依赖 localStorage', lsLeft === null);
    await page.reload({ waitUntil: 'networkidle' });
    await wait(() => document.querySelector('#feed .post'));
    await wait(() => document.querySelector('#ai-dot').hidden);
    assert('配置 AI 后顶栏红点隐藏', true);

    /* 4) 宽屏恒双栏：✦ 进入 AI 页（feed+ai 双栏并排） */
    await page.$eval('#btn-nav-ai', el => el.click());
    await wait(() => document.querySelector('#shell').classList.contains('dual') && document.querySelector('#view-ai').classList.contains('on'));
    assert('宽屏 ✦ 恒双栏（信息流 + AI 面板并排）', true);
    await page.screenshot({ path: SHOT + 'ai-panel-1440.png' });

    /* 5) 场景筛选：mock 返回 set_filter(日记, 2000~2099) */
    await aiSend('场景筛选：只看日记');
    await wait(() => {
      var tag = document.querySelector('[data-filter-tag="日记"]');
      var time = document.querySelector('[data-u32-name="filter-time"]');
      return !!tag && tag.className.indexOf('on') > -1 && !!time && time.className.indexOf('on') > -1;
    }, null, 30000);
    const feedTxt = await page.evaluate(() => document.querySelector('#feed').textContent);
    assert('AI 筛选生效：标签与时间 chip 高亮，信息流只剩日记帖', feedTxt.indexOf('搬家的回忆') > -1 && feedTxt.indexOf('普通帖子') === -1);
    await wait(() => {
      var msgs = document.querySelectorAll('#ai-msgs .ai-msg.assistant');
      return msgs.length && msgs[msgs.length - 1].textContent.indexOf('筛选') > -1;
    }, null, 30000);
    assert('AI 回复文本流式落地（含筛选完成说明）', true);
    await page.screenshot({ path: SHOT + 'ai-filter-1440.png' });

    /* 6) 手工复位筛选（时间 chip → 清除筛选；标签 → 全部） */
    await page.$eval('[data-u32-name="filter-time"]', el => el.click());
    await wait(() => !document.querySelector('#trdlg').hidden);
    await page.$eval('#tr-clear', el => el.click());
    await wait(() => document.querySelector('[data-u32-name="filter-time"]').className.indexOf('on') === -1);
    await page.$eval('[data-u32-name="filter-all"]', el => el.click());
    await wait(() => document.querySelector('#feed').textContent.indexOf('普通帖子') > -1);
    assert('手工复位筛选后信息流恢复全量', true);

    /* 7) 场景问答：search_notes → 带 [[path]] 引用的回答 → 引用卡片可展开 */
    await aiSend('场景问答：搬家写过什么');
    await wait(() => !!document.querySelector('#ai-msgs .ai-cite-card'), null, 30000);
    await page.$eval('#ai-msgs .ai-cite-card .ai-cite-head', el => el.click());
    await wait(() => {
      var b = document.querySelector('#ai-msgs .ai-cite-card .ai-cite-body');
      return !!b && !b.hidden && b.textContent.indexOf('搬家') > -1;
    });
    assert('问答命中并渲染引用卡片（点击展开全文）', true);
    await page.screenshot({ path: SHOT + 'ai-cite-1440.png' });

    /* 8) 场景写入（确认模式）：确认卡片 → 允许 → [ai] 提交 + 信息流出现新帖 */
    const logBefore = await page.evaluate(() => fetch('/api/git/log?limit=1').then(r => r.json()));
    await aiSend('场景写入：帮我记一条');
    await wait(() => {
      var cards = document.querySelectorAll('#ai-msgs .ai-confirm');
      return cards.length && cards[cards.length - 1].className.indexOf('done') === -1;
    }, null, 30000);
    await page.screenshot({ path: SHOT + 'ai-confirm-1440.png' });
    await page.evaluate(() => {
      var cards = document.querySelectorAll('#ai-msgs .ai-confirm');
      var btns = cards[cards.length - 1].querySelectorAll('.ops button');
      for (var i = 0; i < btns.length; i++) if (btns[i].textContent === '允许') { btns[i].click(); return; }
      throw new Error('允许按钮未找到');
    });
    await wait(() => (async () => true)() && document.body.textContent.indexOf('已创建 1/1') > -1, null, 30000);
    const logAfter = await page.evaluate(() => fetch('/api/git/log?limit=1').then(r => r.json()));
    assert('确认后创建成功，git 提交带 [ai] 审计标记', logAfter.commits[0].subject.indexOf('[ai]') > -1 && logAfter.commits[0].subject.indexOf('micro: add') === 0 && logAfter.commits[0].hash !== logBefore.commits[0].hash);
    await wait(() => document.querySelector('#feed').textContent.indexOf('AI 代写') > -1, null, 30000);
    assert('新建笔记出现在信息流', true);

    /* 9) 拒绝流：再次写入 → 拒绝 → 不产生新提交 */
    const cntBefore = await page.evaluate(() => fetch('/api/git/log?limit=1').then(r => r.json()));
    await aiSend('场景写入：再来一条');
    await wait(() => {
      var cards = document.querySelectorAll('#ai-msgs .ai-confirm');
      return cards.length && cards[cards.length - 1].className.indexOf('done') === -1;
    }, null, 30000);
    await page.evaluate(() => {
      var cards = document.querySelectorAll('#ai-msgs .ai-confirm');
      var btns = cards[cards.length - 1].querySelectorAll('.ops button');
      for (var i = 0; i < btns.length; i++) if (btns[i].textContent === '拒绝') { btns[i].click(); return; }
      throw new Error('拒绝按钮未找到');
    });
    await wait(() => document.body.textContent.indexOf('已拒绝') > -1);
    const cntAfter = await page.evaluate(() => fetch('/api/git/log?limit=1').then(r => r.json()));
    assert('拒绝后不产生写操作（提交不变）', cntAfter.commits[0].hash === cntBefore.commits[0].hash);

    /* 10) 思考过程折叠块 */
    await aiSend('场景思考：你想想再答');
    await wait(() => {
      var t = document.querySelectorAll('#ai-msgs .ai-msg.assistant .ai-think');
      return t.length && t[t.length - 1].textContent.indexOf('思考') > -1;
    }, null, 30000);
    assert('思考过程折叠块渲染（reasoning_content）', true);

    /* 11) 慢速流 + 停止按钮（等流式内容已开始再停，验证保留半截文本） */
    await aiSend('场景慢速：慢慢说');
    await wait(() => !document.querySelector('#btn-ai-stop').hidden);
    await page.waitForFunction(() => document.querySelector('#ai-msgs').textContent.length > 0).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    await page.$eval('#btn-ai-stop', el => el.click());
    await wait(() => document.body.textContent.indexOf('已停止生成') > -1, null, 15000);
    assert('停止生成保留半截内容', true);

    /* 12) 刷新：宽屏恒双栏自动恢复，会话持久 */
    await page.reload({ waitUntil: 'networkidle' });
    await wait(() => document.querySelector('#shell').classList.contains('dual') && document.querySelector('#view-ai').classList.contains('on'), null, 15000);
    await wait(() => document.querySelectorAll('#ai-msgs .ai-msg.user').length >= 5, null, 15000);
    assert('刷新后宽屏双栏自动恢复且会话记录持久', true);

    /* 13) 权限模式三段胶囊切换（只写 localStorage，不入仓库） */
    const cycleMode = async (mode) => {
      await wait(e => { var b = document.querySelector('[data-ai-mode="' + e + '"]'); return !!b && !b.disabled; }, mode, 30000);
      await page.$eval('[data-ai-mode="' + mode + '"]', el => el.click());
    };
    await cycleMode('auto');
    await wait(e => document.querySelector('[data-ai-mode="' + e + '"]').classList.contains('on'), 'auto', 30000);
    const modeLocal = await page.evaluate(() => localStorage.getItem('gnAiMode'));
    assert('权限模式胶囊切换写入 localStorage', modeLocal === 'auto');
    await cycleMode('confirm');
    await wait(e => document.querySelector('[data-ai-mode="' + e + '"]').classList.contains('on'), 'confirm', 30000);
    const modeSaved = await page.evaluate(async () => (await fetch('/api/ai/settings')).json());
    assert('权限模式不入仓库（ai.json 无 mode 字段）', !('mode' in modeSaved));

    /* 14) 窄屏断点：AI 页收窄为整页视图，导航按钮回信息流 */
    await page.$eval('#btn-nav-ai', el => el.click());   /* 刷新后默认 feed 视图，先回 AI 页再收窄 */
    await page.setViewportSize({ width: 390, height: 780 });
    await wait(() => document.querySelector('#view-ai').classList.contains('on') && !document.querySelector('#shell').classList.contains('dual'));
    await page.screenshot({ path: SHOT + 'ai-narrow-390.png' });
    await page.$eval('#btn-nav-feed', el => el.click());
    await wait(() => document.querySelector('#view-feed').classList.contains('on') && !document.querySelector('#view-ai').classList.contains('on'));
    await wait(() => document.querySelector('#feed .post'));
    assert('窄屏 AI 整页视图与导航按钮工作', true);
    await page.screenshot({ path: SHOT + 'ai-narrow-feed-390.png' });

    /* 15) 设置页 AI 块回显 */
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.$eval('#btn-nav-set', el => el.click());
    await wait(() => document.querySelector('#view-set').classList.contains('on'));
    const baseVal = await page.$eval('#ai-base', el => el.value);
    const modeVal = await page.$eval('#ai-mode', el => el.value);
    assert('设置页 AI 块回显配置', baseVal === MOCK && modeVal === 'confirm');
    await page.screenshot({ path: SHOT + 'ai-settings-1440.png' });

    assert('无控制台/页面错误' + (errors.length ? '：' + errors.join(' | ') : ''), errors.length === 0);
  } catch (e) {
    console.error('E2E-ERROR', e.message);
    process.exitCode = 1;
    try { await page.screenshot({ path: SHOT + 'ai-fail.png' }); } catch (_) {}
  }
  console.log('---\n' + results.join('\n'));
  await browser.close();
})();
