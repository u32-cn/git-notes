// GUI 断言：折叠/发布器滚动/灯箱右键菜单/设置页分支区段/新标签。
// 用法：NODE_PATH=$(npm root -g) node web/tools/gui-assert.js
// 隔离 HOME + GN_PORT=8645 拉起 server.js，Playwright channel:'chrome'，测完清理。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 8645;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-gui-'));
const BASE = 'http://127.0.0.1:' + PORT;
const SHOT_DIR = path.join(__dirname, '..', 'gui-regression');
let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : String(extra)); }
}
async function api(method, url, body, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  const r = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return r;
}
// 1x1 红 PNG
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, GN_PORT: String(PORT), USERPROFILE: HOME },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (c) => process.stderr.write('[server] ' + c));
  let cookie = '';
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    up = await fetch(BASE + '/healthz').then((r) => r.ok).catch(() => false);
  }
  assert('服务启动', up);
  const first = await api('GET', '/');
  cookie = (first.headers.get('set-cookie') || '').split(';')[0];
  await api('POST', '/api/setup/local', {}, cookie);

  // 长文帖（12 行 → 触发折叠）与带图帖
  await api('POST', '/api/posts', {
    text: Array.from({ length: 12 }, (_, i) => '第' + (i + 1) + '行内容').join('\n'),
    tags: ['备忘'], images: [],
  }, cookie);
  await new Promise((r) => setTimeout(r, 1100));
  const pr = await api('POST', '/api/posts', {
    text: '带图测试帖', tags: [], images: [{ ext: 'png', base64: TINY_PNG_B64 }],
  }, cookie);
  assert('带图帖发布', pr.status === 200);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  /* 1. 长笔记折叠 */
  await page.waitForSelector('.post .ptext', { timeout: 5000 });
  const folded = await page.$('.ptext.folded');
  assert('长帖默认折叠', !!folded);
  const tgl = await page.$('.fold-toggle');
  assert('折叠按钮存在且文案为展开', tgl && (await tgl.textContent()).includes('展开'));
  await tgl.click();
  await page.waitForFunction(() => !document.querySelector('.ptext.folded'), null, { timeout: 3000 }).catch(() => {});
  assert('点击后展开', !(await page.$('.ptext.folded')));
  const tglText = await (await page.$('.fold-toggle')).textContent();
  assert('按钮变收起', tglText.includes('收起'), tglText);
  await (await page.$('.fold-toggle')).click();
  await page.waitForFunction(() => !!document.querySelector('.ptext.folded'), null, { timeout: 3000 }).catch(() => {});
  assert('再次点击恢复折叠', !!(await page.$('.ptext.folded')));

  /* 2. 发布器长文本可滚动 */
  await page.fill('#cap-input', Array.from({ length: 40 }, (_, i) => '行' + i).join('\n'));
  const oy = await page.$eval('#cap-input', (el) => getComputedStyle(el).overflowY);
  const scrollable = await page.$eval('#cap-input', (el) => el.scrollHeight > el.clientHeight);
  assert('发布器 overflow-y:auto', oy === 'auto', oy);
  assert('发布器内容超高出现滚动', scrollable);

  /* 3. 灯箱右键菜单：复制 + 保存 */
  await page.click('img.gimg');
  await page.waitForSelector('#lightbox:not([hidden])', { timeout: 3000 });
  await page.$eval('#lb-img', (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 })));
  await page.waitForTimeout(200);
  assert('右键菜单出现', !(await page.$eval('#lb-menu', (el) => el.hidden)));
  const menuVisible = await page.$eval('#lb-menu', (el) => el.getBoundingClientRect().width > 0);
  assert('右键菜单可见', menuVisible);
  // 复制图片（canvas → clipboard；headless chrome 已授权剪贴板）
  await page.click('#lb-copy');
  await page.waitForFunction(() => {
    const t = document.querySelector('#toast');
    return t && !t.hidden && t.textContent.includes('复制');
  }, null, { timeout: 5000 }).catch(() => {});
  const copyToast = await page.$eval('#toast', (el) => el.textContent).catch(() => '');
  assert('复制图片成功提示', copyToast.includes('已复制到剪贴板'), copyToast);
  const clipOk = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      return items.some((it) => it.types.includes('image/png'));
    } catch (_) { return false; }
  });
  assert('剪贴板确有 PNG 图片', clipOk);
  // 保存图片（下载事件）：复制点击已触发「点任意处收菜单」，需重新唤出右键菜单
  const dlPromise = page.waitForEvent('download', { timeout: 5000 });
  await page.$eval('#lb-img', (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 })));
  await page.waitForTimeout(150);
  await page.click('#lb-save');
  const dl = await dlPromise.catch(() => null);
  assert('保存图片触发下载', !!dl && /\.png$/.test(dl.suggestedFilename() || ''), dl && dl.suggestedFilename());
  await page.keyboard.press('Escape');
  assert('Esc 关灯箱同时收菜单', await page.$eval('#lightbox', (el) => el.hidden));

  /* 4. 设置页：新标签（分支设置已删除——分支定死 main） */
  await page.evaluate(() => { document.querySelector('#btn-settings').click(); });
  await page.waitForSelector('#settings:not([hidden])');
  assert('分支设置已删除', (await page.$('#branch-input')) === null);
  assert('标签含 想法/感悟', await page.evaluate(() => {
    const ts = [...document.querySelectorAll('#settings-tags .chip')].map((e) => e.textContent.replace('✕', ''));
    return ts.includes('想法') && ts.includes('感悟');
  }));
  await page.screenshot({ path: path.join(SHOT_DIR, 'feat-branch-tags-settings.png'), fullPage: false });
  await page.keyboard.press('Escape');

  /* 5. 折叠帖信息流截图（展开态） */
  await (await page.$('.fold-toggle')).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, 'feat-fold-lightbox-feed.png'), fullPage: false });

  /* 6. 发布器滚动截图（viewport 内可见滚动条语义） */
  await page.evaluate(() => document.querySelector('#cap-input').focus());
  await page.screenshot({ path: path.join(SHOT_DIR, 'feat-composer-scroll.png') });

  assert('无页面 JS 错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\n结果: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
