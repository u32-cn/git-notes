/* 方案A「提交图谱」重设计 E2E 回归：轨线/节点 → 发布 → 编辑 → 搜索高亮 → 删除（自清理）
   注：页面 CSP 禁 eval，不能用 waitForFunction；用 Node 侧轮询 + evaluate（CDP 通道不受 CSP 限） */
const { chromium } = require('playwright');

const PREFIX = '样式验证-提交图谱';
(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const results = [];
  const assert = (name, ok) => { results.push((ok ? 'PASS' : 'FAIL') + ' ' + name); console.log(results[results.length - 1]); if (!ok) process.exitCode = 1; };
  /* fn 由 page.evaluate 调用并收到 arg；timeout 毫秒，默认 20s */
  const wait = async (fn, arg, timeout) => {
    const t0 = Date.now();
    for (;;) {
      if (await page.evaluate(fn, arg)) return;
      if (Date.now() - t0 > (timeout || 20000)) throw new Error('wait timeout');
      await new Promise(r => setTimeout(r, 200));
    }
  };

  try {
    await page.goto(process.env.GN_E2E_BASE || 'http://127.0.0.1:8644/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#feed .post', { timeout: 15000 });

    // 1) 轨线结构与新配色（倒排：最新帖在末尾，末帖节点带 accent 光晕）
    const nodeColor = await page.$eval('#feed .post:last-of-type .post-node', el => getComputedStyle(el).borderColor);
    assert('末帖节点为 accent 橙 (' + nodeColor + ')', nodeColor.includes('232, 72, 42'));
    const railN = await page.$$eval('#feed .post .post-rail', els => els.length);
    const postN = await page.$$eval('#feed .post', els => els.length);
    assert('每帖都有轨线 (' + railN + '/' + postN + ')', railN === postN && postN > 0);

    // 1.5) 顶栏同步徽章（branch + 同步态；点击切设置页）
    await wait(() => {
      var p = document.querySelector('#sync-pill');
      return !!p && !p.hidden && p.textContent.trim().length > 0;
    });
    const pillText = await page.$eval('#sync-pill', el => el.textContent.trim());
    assert('同步徽章显示: ' + pillText, /已同步|↑|仅本机|冲突|同步失败/.test(pillText));
    await page.$eval('#sync-pill', el => el.click());
    await wait(() => document.querySelector('#view-set').classList.contains('on'));
    const keysVisible = await page.$eval('#btn-show-pubkey', el => !el.hidden);
    const keyStatus = await page.$eval('#key-status', el => el.textContent);
    assert('设置页渲染（密钥常显按钮可见 · ' + keyStatus + '）', keysVisible && keyStatus.length > 0);
    await new Promise(r => setTimeout(r, 350));   /* 等渲染稳定再截图 */
    await page.screenshot({ path: 'S:/vtxf/vtxf-work/projects/vtxf/git-notes/web/gui-regression/ui-settings-4sec.png' });
    await page.$eval('#btn-nav-feed', el => el.click());
    await wait(() => document.querySelector('#view-feed').classList.contains('on'));
    assert('徽章点击进设置页/导航返回正常', true);

    // 2) 发布
    const TXT1 = PREFIX + ' E2E 帖子';
    await page.fill('#cap-input', TXT1);
    await page.$eval('#btn-publish', el => el.click());
    await wait(() => { var el = document.querySelector('#toast'); return !!el && el.textContent.indexOf('已发布') > -1; });
    await wait(t => { var el = document.querySelector('#feed .post:last-of-type .ptext'); return !!el && el.textContent.indexOf(t) > -1; }, TXT1);
    assert('发布成功且贴底（倒排末位）', true);
    await page.screenshot({ path: 'S:/vtxf/vtxf-work/projects/vtxf/git-notes/web/gui-regression/ui-style-a-published.png' });

    // 3) 编辑（保存后重读断言）
    const TXT2 = PREFIX + ' E2E 已编辑';
    await page.$eval('#feed .post:last-of-type .act-edit', el => el.click());
    await page.waitForSelector('#edit-text', { timeout: 5000 });
    await page.fill('#edit-text', TXT2);
    await page.$eval('#btn-edit-save', el => el.click());
    await wait(() => { var el = document.querySelector('#toast'); return !!el && el.textContent.indexOf('已保存') > -1; });
    await wait(t => { var el = document.querySelector('#feed .post:last-of-type .ptext'); return !!el && el.textContent.indexOf(t) > -1; }, TXT2);
    assert('编辑保存后重读为最新内容', true);
    await page.screenshot({ path: 'S:/vtxf/vtxf-work/projects/vtxf/git-notes/web/gui-regression/ui-style-a-edited.png' });

    // 4) 全库搜索命中高亮
    await page.fill('#search', '样式验证');
    await page.dispatchEvent('#search', 'input');
    await wait(() => { var m = document.querySelector('#search-meta'); return !!m && !m.hidden && document.body.textContent.indexOf('全库命中') > -1; });
    const marks = await page.$$eval('#feed mark', els => els.length);
    assert('搜索命中且高亮 (' + marks + ' 处)', marks > 0);
    await page.screenshot({ path: 'S:/vtxf/vtxf-work/projects/vtxf/git-notes/web/gui-regression/ui-style-a-search.png' });
    await page.fill('#search', '');
    await page.dispatchEvent('#search', 'input');
    await wait(() => document.querySelector('#search-meta').hidden);

    // 5) 删除（确认框）
    await page.$eval('#feed .post:last-of-type .act-del', el => el.click());
    await wait(() => !document.querySelector('#dlg').hidden);
    await page.$eval('#dlg-ok', el => el.click());
    await wait(t => document.body.textContent.indexOf(t) === -1, TXT2);
    assert('删除后信息流无残留', true);
    await page.screenshot({ path: 'S:/vtxf/vtxf-work/projects/vtxf/git-notes/web/gui-regression/ui-style-a-deleted.png' });

    assert('无控制台/页面错误' + (errors.length ? '：' + errors.join(' | ') : ''), errors.length === 0);
  } catch (e) {
    console.error('E2E-ERROR', e.message);
    process.exitCode = 1;
  }

  /* 失败兜底自清理：仅当首帖确为测试帖时经界面删除（先退出可能的编辑态/关闭对话框），绝不碰用户帖子 */
  try {
    const isTest = await page.evaluate(() => {
      var el = document.querySelector('#feed .post:last-of-type .ptext') || document.querySelector('#feed .post:last-of-type #edit-text');
      return !!el && (el.value || el.textContent).indexOf('样式验证-提交图谱') > -1;
    });
    if (isTest) {
      await page.evaluate(() => {
        var d = document.querySelector('#dlg');
        var c = document.querySelector('#dlg-cancel');
        if (d && !d.hidden && c) c.click();
        var b = document.querySelector('#btn-edit-cancel');
        if (b) b.click();
      });
      await new Promise(r => setTimeout(r, 400));
      await page.evaluate(() => { var b = document.querySelector('#feed .post:last-of-type .act-del'); if (b) b.click(); });
      await new Promise(r => setTimeout(r, 400));
      await page.evaluate(() => { var d = document.querySelector('#dlg'); var b = document.querySelector('#dlg-ok'); if (b && d && !d.hidden) b.click(); });
      await new Promise(r => setTimeout(r, 2500));
      console.log('cleanup: 已尽力删除残留测试帖');
    }
  } catch (_) {}
  console.log('---\n' + results.join('\n'));
  await browser.close();
})();
