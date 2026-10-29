/* 待办复选框 E2E：发布带「待办」帖 → 卡片出现复选框 → 勾选变「已完成待办」（写后重读）→ 取消恢复 → 筛选联动 → 删除自清理
   注：页面 CSP 禁 eval，不能用 waitForFunction；用 Node 侧轮询 + evaluate（CDP 通道不受 CSP 限） */
const { chromium } = require('playwright');

const PREFIX = '待办测试-E2E';
(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    await page.goto(process.env.GN_E2E_BASE || 'http://127.0.0.1:8644/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#feed .post, #feed .feed-empty', { timeout: 15000 });

    // 0) 迁移断言：打开页面后标签清单应含「已完成待办」
    await wait(() => {
      var box = document.querySelector('#cap-tags');
      return !!box && box.textContent.indexOf('已完成待办') > -1;
    }, null, 15000);
    assert('打开页面后标签清单含「已完成待办」（存量迁移生效）', true);

    // 1) 发布带「待办」标签的测试帖
    const TXT = PREFIX + ' 复选框帖子';
    await page.fill('#cap-input', TXT);
    await page.$eval('#cap-tags', el => {
      var chips = el.querySelectorAll('.chip');
      for (var i = 0; i < chips.length; i++) if (chips[i].textContent.indexOf('待办') > -1 && chips[i].textContent.indexOf('已完成') === -1) { chips[i].click(); return; }
      throw new Error('chip 待办 not found');
    });
    await page.$eval('#btn-publish', el => el.click());
    await wait(t => { var el = document.querySelector('#feed .post:last-of-type .ptext'); return !!el && el.textContent.indexOf(t) > -1; }, TXT);
    assert('发布成功且出现在信息流首位', true);

    // 2) 卡片出现未勾选的待办复选框
    await wait(() => {
      var c = document.querySelector('#feed .post:last-of-type .todo-check');
      return !!c && !!c.querySelector('.todo-check-input') && !c.querySelector('.todo-check-input').checked;
    });
    assert('待办帖卡片渲染复选框（未勾选）', true);
    await page.screenshot({ path: 'S:/vtxf/vtxf-work/projects/vtxf/git-notes/web/gui-regression/ui-todo-unchecked.png' });

    // 3) 勾选 → 标签变「已完成待办」（写后重读；若撞 409 busy 等待后重试点击）
    const clickUntil = async (condFn, timeout) => {
      const t0 = Date.now();
      for (;;) {
        if (await page.evaluate(condFn)) return;
        if (Date.now() - t0 > timeout) throw new Error('clickUntil timeout');
        await page.evaluate(() => {
          var el = document.querySelector('#feed .post:last-of-type .todo-check-input');
          if (el && !el.disabled) el.click();
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
      }
    };
    await clickUntil(() => {
      var c = document.querySelector('#feed .post:last-of-type .todo-check');
      var tags = document.querySelector('#feed .post:last-of-type .ptags');
      return !!c && c.querySelector('.todo-check-input').checked && !!tags && tags.textContent.indexOf('已完成待办') > -1;
    }, 60000);
    assert('勾选后标签变「已完成待办」，复选框呈勾选态', true);
    await page.screenshot({ path: 'S:/vtxf/vtxf-work/projects/vtxf/git-notes/web/gui-regression/ui-todo-checked.png' });

    // 3.5) 筛选联动：「已完成待办」筛选下能命中该帖
    await page.evaluate(() => {
      var chips = document.querySelectorAll('#filter-row .chip');
      for (var i = 0; i < chips.length; i++) if (chips[i].getAttribute('data-filter-tag') === '已完成待办') { chips[i].click(); return; }
    });
    await wait(t => {
      var el = document.querySelector('#feed .post:last-of-type .ptext');
      return !!el && el.textContent.indexOf(t) > -1;
    }, TXT);
    assert('「已完成待办」筛选命中该帖', true);
    await page.evaluate(() => { document.querySelector('[data-u32-name="filter-all"]').click(); });

    // 4) 取消勾选 → 恢复「待办」（同样带重试）
    await clickUntil(() => {
      var c = document.querySelector('#feed .post:last-of-type .todo-check');
      var tags = document.querySelector('#feed .post:last-of-type .ptags');
      return !!c && !c.querySelector('.todo-check-input').checked && !!tags && tags.textContent.indexOf('# 待办') > -1 && tags.textContent.indexOf('已完成待办') === -1;
    }, 60000);
    assert('取消勾选后恢复「待办」', true);

    // 5) 删除自清理
    await page.$eval('#feed .post:last-of-type .act-del', el => el.click());
    await wait(() => !document.querySelector('#dlg').hidden);
    await page.$eval('#dlg-ok', el => el.click());
    await wait(t => document.body.textContent.indexOf(t) === -1, TXT, 60000);
    assert('删除后信息流无残留', true);

    assert('无控制台/页面错误' + (errors.length ? '：' + errors.join(' | ') : ''), errors.length === 0);
  } catch (e) {
    console.error('E2E-ERROR', e.message);
    process.exitCode = 1;
  }

  /* 失败兜底自清理：仅当首帖确为测试帖时经界面删除 */
  try {
    const isTest = await page.evaluate(() => {
      var el = document.querySelector('#feed .post:last-of-type .ptext') || document.querySelector('#feed .post:last-of-type #edit-text');
      return !!el && (el.value || el.textContent).indexOf('待办测试-E2E') > -1;
    });
    if (isTest) {
      await page.evaluate(() => {
        var d = document.querySelector('#dlg'); var c = document.querySelector('#dlg-cancel');
        if (d && !d.hidden && c) c.click();
        var b = document.querySelector('#btn-edit-cancel'); if (b) b.click();
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
