/* 附件 E2E：发布器选附件（中文文件名）→ 卡片附件条 → 编辑增/删附件 → 删除自清理（先校验首帖确为测试帖）
   注：页面 CSP 禁 eval，禁 waitForFunction；写操作用 clickUntil 轮询防 409 busy。截图存 web/gui-regression/。 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PREFIX = '附件测试-E2E';
const DIR = __dirname;
// 造测试文件（中文名 + txt + pdf）
const f1 = path.join(DIR, 'fixture-附件测试文档.txt');
const f2 = path.join(DIR, 'fixture-新增说明.pdf');
fs.writeFileSync(f1, 'E2E 附件内容 ' + Date.now());
fs.writeFileSync(f2, '%PDF-1.4 e2e');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const results = [];
  const assert = (name, ok) => { results.push((ok ? 'PASS' : 'FAIL') + ' ' + name); console.log(results[results.length - 1]); if (!ok) process.exitCode = 1; };
  const wait = async (fn, arg, timeout) => {
    const t0 = Date.now();
    for (;;) {
      if (await page.evaluate(fn, arg)) return;
      if (Date.now() - t0 > (timeout || 20000)) throw new Error('wait timeout');
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const clickUntil = async (condFn, actFn, timeout) => {
    const t0 = Date.now();
    for (;;) {
      if (await page.evaluate(condFn)) return;
      if (Date.now() - t0 > timeout) throw new Error('clickUntil timeout');
      await actFn().catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
    }
  };

  try {
    await page.goto(process.env.GN_E2E_BASE || 'http://127.0.0.1:8644/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#feed .post, #feed .feed-empty', { timeout: 15000 });

    // 1) 发布：文本 + 附件（中文文件名）
    await page.fill('#cap-input', PREFIX + ' 附件帖子');
    await page.setInputFiles('#cap-file-file', f1);
    await wait(() => !!document.querySelector('#cap-files .file-chip'));
    assert('发布器出现附件 chip（原始名）', (await page.textContent('#cap-files .fc-name')) === 'fixture-附件测试文档.txt');
    await page.screenshot({ path: path.join(DIR, 'ui-files-composer.png') });
    await page.click('#btn-publish');
    await wait((t) => {
      var el = document.querySelector('#feed .post:last-of-type .ptext');
      return !!el && el.textContent.indexOf(t) > -1;
    }, PREFIX + ' 附件帖子', 30000);
    assert('发布成功且在信息流首位', true);

    // 2) 卡片附件条：文件名 + 下载链接指向 /media
    await wait(() => {
      var a = document.querySelector('#feed .post:last-of-type .pfile');
      return !!a && a.getAttribute('href').indexOf('/media/') > -1;
    }, null, 15000);
    const href = await page.getAttribute('#feed .post:last-of-type .pfile', 'href');
    assert('卡片附件条渲染且 href=/media/', !!href && href.indexOf('/media/') > -1, href);
    await page.screenshot({ path: path.join(DIR, 'ui-files-card.png') });

    // 3) 编辑：追加 pdf 附件（写后重读，clickUntil 防 409）
    await clickUntil(
      () => !!document.querySelector('#feed .post:last-of-type #edit-box'),
      () => page.click('#feed .post:last-of-type .act-edit'),
      30000
    );
    await page.setInputFiles('#edit-file-file', f2);
    await wait(() => document.querySelectorAll('#edit-files .file-chip').length === 2);
    await page.click('#btn-edit-save');
    await wait(() => document.querySelectorAll('#feed .post:last-of-type .pfile').length === 2, null, 60000);
    const names = await page.$$eval('#feed .post:last-of-type .pfile .pf-name', (els) => els.map((e) => e.textContent));
    assert('编辑后卡片 2 个附件（含新增 pdf 原始名）', names.some((n) => n === 'fixture-新增说明.pdf'), names);
    await page.screenshot({ path: path.join(DIR, 'ui-files-edited.png') });

    // 4) 删除自清理：先校验首帖确为测试帖，再经界面删除
    const firstText = await page.textContent('#feed .post:last-of-type .ptext');
    assert('删除前校验首帖为测试帖', firstText.indexOf(PREFIX) > -1, firstText);
    if (firstText.indexOf(PREFIX) > -1) {
      await page.click('#feed .post:last-of-type .act-del');
      await page.click('#dlg-ok');
      await wait((t) => {
        var el = document.querySelector('#feed .post:last-of-type .ptext');
        return !el || el.textContent.indexOf(t) === -1;
      }, PREFIX, 30000);
      assert('测试帖已经界面删除', true);
    }
  } catch (e) {
    console.error('E2E ABORT:', e.message);
    process.exitCode = 1;
  } finally {
    // 兜底清理：任何残留测试帖经界面删除
    try {
      await page.goto(process.env.GN_E2E_BASE || 'http://127.0.0.1:8644/', { waitUntil: 'networkidle' });
      for (let i = 0; i < 10; i++) {
        const txt = await page.evaluate(() => {
          var el = document.querySelector('#feed .post:last-of-type .ptext');
          return el ? el.textContent : '';
        });
        if (txt.indexOf(PREFIX) === -1) break;
        await page.click('#feed .post:last-of-type .act-del');
        await page.click('#dlg-ok');
        await page.waitForTimeout(3000);
      }
    } catch (_) {}
    await browser.close();
    fs.unlinkSync(f1); fs.unlinkSync(f2);
  }
  if (errors.length) { console.log('PAGE ERRORS:', errors); process.exitCode = 1; }
  console.log(results.every((r) => r.startsWith('PASS')) && !errors.length ? 'RESULT: ALL PASS' : 'RESULT: FAIL');
})();
