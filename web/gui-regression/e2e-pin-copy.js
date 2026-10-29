/* 钉住 + 链接右键复制 E2E：发布带链接帖 → 正文链接右键复制（clipboard 回读）→ 钉住按钮 →
   底部「📌 钉住」区块出现且日期流不重复 → 刷新保持 → 取钉恢复 → 测试帖删除自清理
   注：CSP 禁 eval 字符串谓词；用 Node 侧轮询 + evaluate。前置：GN_E2E_BASE 指向隔离服务。 */
const { chromium } = require('playwright');

const PREFIX = '钉住测试-E2E';
(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: process.env.GN_E2E_BASE || 'http://127.0.0.1:18649' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const results = [];
  const assert = (name, ok) => { results.push((ok ? 'PASS' : 'FAIL') + ' ' + name); console.log(results[results.length - 1]); if (!ok) process.exitCode = 1; };
  const wait = async (fn, arg, timeout) => {
    const t0 = Date.now();
    for (;;) {
      if (await page.evaluate(fn, arg)) return;
      if (Date.now() - t0 > (timeout || 20000)) throw new Error('wait timeout');
      await new Promise(r => setTimeout(r, 200));
    }
  };

  try {
    const BASE = process.env.GN_E2E_BASE || 'http://127.0.0.1:18649';
    /* fresh 仓库先 API 初始化，跳过引导浮层 */
    const c0 = (await fetch(BASE + '/').then(r => r.headers.get('set-cookie') || '')).split(';')[0];
    const st0 = await (await fetch(BASE + '/api/status', { headers: { cookie: c0 } })).json();
    if (st0.stage === 'fresh') await fetch(BASE + '/api/setup/local', { method: 'POST', headers: { cookie: c0, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#feed .post, #feed .feed-empty', { timeout: 15000 });

    // 1) 发布带链接的测试帖
    const TXT = PREFIX + ' 链接帖 https://example.com/pin-demo 正文';
    await page.fill('#cap-input', TXT);
    await page.$eval('#btn-publish', el => el.click());
    await wait(t => {
      var cards = document.querySelectorAll('#feed .post:not(.pinned) .ptext');
      for (var i = 0; i < cards.length; i++) if (cards[i].textContent.indexOf(t) > -1) return true;
      return false;
    }, PREFIX);
    assert('发布成功且出现在信息流（日期流）', true);

    // 2) 正文链接右键 → 复制 → 剪贴板回读（定位含测试帖正文的卡片）
    const cardEl = page.locator('#feed .post:not(.pinned)', { has: page.locator('.ptext', { hasText: PREFIX }) }).last();
    await cardEl.locator('.ptext a').last().hover();
    await cardEl.locator('.ptext a').last().click({ button: 'right' });
    await wait(() => {
      var t = document.querySelector('#toast');
      return !!t && !t.hidden && t.textContent.indexOf('已复制链接') > -1;
    }, null, 5000);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert('右键复制：剪贴板=https://example.com/pin-demo', clip === 'https://example.com/pin-demo', clip);

    // 3) 钉住该帖 → 底部出现「📌 钉住」区块，且该帖从日期流消失（不重复渲染）
    await cardEl.locator('.act-pin').click();
    await wait(() => {
      var sep = document.querySelector('#feed .pinsep');
      var pins = document.querySelectorAll('#feed .post.pinned');
      var dateCards = 0, pinPaths = {};
      document.querySelectorAll('#feed .post').forEach(function (p) {
        if (p.classList.contains('pinned')) pinPaths[p.getAttribute('data-path')] = 1;
        else dateCards++;
      });
      var dup = false;
      document.querySelectorAll('#feed .post:not(.pinned)').forEach(function (p) { if (pinPaths[p.getAttribute('data-path')]) dup = true; });
      return !!sep && pins.length >= 1 && !dup;
    }, null, 15000);
    assert('钉住后底部区块出现且不与日期流重复', true);
    const pinPath = await page.$eval('#feed .post.pinned', el => el.getAttribute('data-path'));

    // 4) 刷新后钉住保持（main.json 持久化，写后重读）
    await page.reload({ waitUntil: 'networkidle' });
    await wait(pp => {
      var el = document.querySelector('#feed .post.pinned');
      return !!el && el.getAttribute('data-path') === pp;
    }, pinPath, 15000);
    assert('刷新后钉住保持', true);

    // 5) 取钉 → 区块消失
    await page.$eval('#feed .post.pinned .act-pin', el => el.click());
    await wait(() => !document.querySelector('#feed .pinsep') && !document.querySelector('#feed .post.pinned'), null, 15000);
    assert('取钉后钉住区块消失', true);

    // 6) 清理测试帖（经 API，走与界面删除同一端点）
    const cookie = (await ctx.cookies()).map(c => c.name + '=' + c.value).join('; ');
    const list = await (await fetch(BASE + '/api/posts', { headers: { cookie } })).json();
    for (const p of (list.posts || [])) {
      if ((p.text || '').indexOf(PREFIX) > -1) {
        await fetch(BASE + '/api/posts', { method: 'DELETE', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p.path }) });
      }
    }
    assert('清理：测试帖已删除', true);
  } catch (e) {
    assert('异常中断：' + e.message, false);
  }
  assert('无控制台/页面错误', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));
  await browser.close();
  console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
})();
