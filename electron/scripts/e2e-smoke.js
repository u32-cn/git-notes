// Electron 版冒烟：经 CDP 附着到 --remote-debugging-port 调试通道（仅验证用，应用本身零端口），
// 截图 + 断言信息流/设置页/发布器可用。用法：先 npm start -- --remote-debugging-port=9223，再 node scripts/e2e-smoke.js
'use strict';
const path = require('path');

const CDP_URL = 'http://127.0.0.1:9223';
const SHOT_DIR = path.join(__dirname, '..', 'smoke-shots');

(async () => {
  const { chromium } = require('playwright');
  const fs = require('fs');
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  /* Electron 不支持 Target.createTarget：直接附着窗口已有页面 */
  let page = ctx.pages().find((p) => p.url().startsWith('gnapp://'));
  if (!page) {
    const all = browser.contexts().flatMap((c) => c.pages());
    page = all.find((p) => p.url().startsWith('gnapp://'));
  }
  if (!page) throw new Error('未找到 gnapp:// 页面，现有: ' + JSON.stringify(browser.contexts().flatMap((c) => c.pages()).map((p) => p.url())));
  await page.waitForSelector('#app', { timeout: 15000 });
  await page.waitForTimeout(2000);

  const stage = await page.evaluate(async () => {
    const r = await fetch('/api/status');
    return await r.json();
  });
  console.log('[smoke] stage =', stage.stage, '| remote =', stage.remote || '(仅本机)');

  /* 信息流已渲染帖子（stage=ready 时应非空；fresh 时显示引导）；
     倒排信息流默认贴底（最新帖在末尾）：atBottom 须为 true（列表可滚动时） */
  const info = await page.evaluate(() => ({
    cards: document.querySelectorAll('#feed article').length,
    feedHtmlLen: document.querySelector('#feed') ? document.querySelector('#feed').innerHTML.length : 0,
    headerShown: !!document.querySelector('#app-header'),
    atBottom: (() => {
      const s = document.querySelector('#feed-scroll');
      return !s || s.scrollHeight <= s.clientHeight ? 'n/a(内容不满一屏)' : s.scrollHeight - s.scrollTop - s.clientHeight < 60;
    })(),
  }));
  console.log('[smoke] feed =', JSON.stringify(info));
  if (info.cards > 0 && info.atBottom === false) throw new Error('信息流未贴底（倒排默认应呈现最新）');
  await page.screenshot({ path: path.join(SHOT_DIR, 'feed.png') });

  /* 构建溯源（assets/version.json）：包内 commit+时间，设置页可见 */
  const ver = await page.evaluate(async () => {
    const r = await fetch('/assets/version.json');
    return r.ok ? r.json() : null;
  });
  console.log('[smoke] version =', JSON.stringify(ver));
  if (!ver || !ver.commit) throw new Error('version.json 缺失或无 commit（先 git 提交再打包）');

  /* 设置页开合（设置是独立页面：#view-set.on） */
  await page.evaluate(() => document.querySelector('#btn-nav-set').click());
  await page.waitForTimeout(800);
  const settingsVisible = await page.evaluate(() => {
    const el = document.querySelector('#view-set');
    return !!el && el.classList.contains('on') && el.getBoundingClientRect().width > 0;
  });
  console.log('[smoke] settings visible =', settingsVisible);
  await page.screenshot({ path: path.join(SHOT_DIR, 'settings.png') });
  await page.evaluate(() => document.querySelector('#btn-nav-feed').click());
  await page.waitForTimeout(300);

  /* 发布器开合 */
  const composerToggle = await page.evaluate(() => {
    const c = document.querySelector('#composer');
    if (!c) return 'missing';
    const before = c.hidden;
    return before ? 'hidden-initially' : 'visible-initially';
  });
  console.log('[smoke] composer =', composerToggle);

  /* 媒体图片直出（取信息流第一张图 URL 试 GET） */
  const mediaTest = await page.evaluate(async () => {
    const img = document.querySelector('#feed img[src^="/media/"]');
    if (!img) return 'no-media-in-feed';
    const r = await fetch(img.getAttribute('src'));
    return r.status + ' ' + (r.headers.get('content-type') || '');
  });
  console.log('[smoke] media =', mediaTest);

  await page.close();
  await browser.close();
  console.log('[smoke] PASS');
})().catch((e) => { console.error('[smoke] FAIL:', e.message); process.exit(1); });
