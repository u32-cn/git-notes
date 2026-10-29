/* 「打开本地仓库」按钮 E2E：徽章旁按钮显隐 + 点击弹系统文件管理器（会真实弹窗，自关闭由用户系统负责）
   注：本机未常驻 playwright，历史上用临时 npm i playwright 跑；也可用会话内浏览器人工回归
   （参考截图 feat-open-repo-1440.png：顶栏按钮 + toast「已打开本地仓库文件夹」） */
const { chromium } = require('playwright');

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
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
    await page.goto('http://127.0.0.1:8644/', { waitUntil: 'networkidle' });
    await page.waitForSelector('#feed .post', { timeout: 15000 });

    // 1) 按钮随同步徽章出现（桌面端 platform=win32）
    await wait(() => {
      var p = document.querySelector('#sync-pill'), b = document.querySelector('#btn-open-repo');
      return !!p && !p.hidden && !!b && !b.hidden;
    });
    assert('打开仓库按钮显示在同步徽章旁', true);

    // 2) 点击 → toast 成功提示（服务端真实拉起资源管理器）
    await page.$eval('#btn-open-repo', el => el.click());
    await wait(() => {
      var t = document.querySelector('#toast');
      return !!t && !t.hidden && t.textContent.indexOf('已打开本地仓库文件夹') > -1;
    });
    assert('点击后 toast 提示成功', true);

    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: 'feat-open-repo-1440.png' });
  } catch (e) {
    console.log('FAIL 异常: ' + e.message);
    process.exitCode = 1;
  }
  if (errors.length) { console.log('页面错误: ' + errors.join(' | ')); process.exitCode = 1; }
  await browser.close();
})();
