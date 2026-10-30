'use strict';
/* AI 提供商下拉（远端 JSON 版）E2E：
   /api/ai/providers 代理 OSS 清单 → 下拉动态渲染（含自定义大模型）→ 选预设自动填 + 覆盖确认 →
   选自定义不动字段。隔离：临时 USERPROFILE + GN_PORT。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18761;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ai-prov-'));
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: Object.assign({}, process.env, { USERPROFILE: HOME, HOME, GN_PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => process.stdout.write('[srv] ' + d));
server.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));

(async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  let r = await fetch(BASE + '/', { redirect: 'manual' });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  await fetch(BASE + '/api/setup/local', { method: 'POST', headers: { cookie } });

  // 端点：返回清单（远端可达 → builtin:false + custom；不可达 → builtin:true 兜底，两者都合法）
  const prov = await (await fetch(BASE + '/api/ai/providers', { headers: { cookie } })).json();
  ok(Array.isArray(prov.providers) && prov.providers.length >= 5, 'providers 端点返回清单（' + prov.providers.length + ' 项，builtin=' + prov.builtin + '）');
  const ids = prov.providers.map(p => p.id);
  ok(ids.includes('zhipu-free') && ids.includes('zhipu-coding') && ids.includes('custom'), '清单含智谱免费/编程套餐/自定义');
  const zf = prov.providers.find(p => p.id === 'zhipu-free');
  ok(zf.baseURL === 'https://open.bigmodel.cn/api/paas/v4', '智谱免费走开放平台通用端点：' + zf.baseURL);
  const zc = prov.providers.find(p => p.id === 'zhipu-coding');
  ok(zc.baseURL === 'https://open.bigmodel.cn/api/coding/paas/v4', '编程套餐走 coding 端点：' + zc.baseURL);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + '/');
  await page.waitForTimeout(1000);
  await page.evaluate(() => showView('set'));
  await page.waitForTimeout(300);

  // 下拉动态渲染：占位 + 清单项
  const opts = await page.$$eval('#ai-provider option', els => els.map(e => e.value));
  ok(opts[0] === '' && opts.includes('custom') && opts.includes('zhipu-coding'), '下拉渲染 = 占位 + 远端清单（含自定义）');
  ok(await page.$eval('#ai-key-link', el => el.classList.contains('is-off')), '未选择提供商时获取 Key 按钮置灰');

  // 选智谱免费 → 自动填（paas/v4）
  await page.selectOption('#ai-provider', 'zhipu-free');
  await page.waitForTimeout(300);
  ok((await page.$eval('#ai-base', el => el.value)) === 'https://open.bigmodel.cn/api/paas/v4', '智谱免费自动填 paas/v4');
  ok((await page.$eval('#ai-model', el => el.value)) === 'glm-4.7-flash', 'model 填 glm-4.7-flash');
  ok((await page.$eval('#ai-key-link', el => el.href)) === 'gn-external://https://bigmodel.cn/apikey/platform', 'Key 链接带 gn-external 前缀指向 bigmodel.cn/apikey/platform');

  await page.fill('#ai-key', 'test-key-zf');
  await page.click('#btn-ai-save');
  await page.waitForTimeout(1200);
  const saved = await (await fetch(BASE + '/api/ai/settings', { headers: { cookie } })).json();
  ok(saved.model === 'glm-4.7-flash' && saved.apiKey === 'test-key-zf', '保存入库');
  ok(saved.extra && saved.extra.thinking && saved.extra.thinking.type === 'disabled', '思考显式关闭随配置入库：' + JSON.stringify(saved.extra));

  // 已有配置 → 切换弹覆盖确认，取消不改
  await page.selectOption('#ai-provider', 'deepseek');
  await page.waitForTimeout(300);
  ok(!(await page.$eval('#dlg', el => el.hidden)), '已有配置时切换弹覆盖确认');
  await page.click('#dlg-cancel');
  await page.waitForTimeout(200);
  ok((await page.$eval('#ai-model', el => el.value)) === 'glm-4.7-flash', '取消后配置未改');

  // 编程套餐：确认覆盖 → coding 端点
  await page.selectOption('#ai-provider', 'zhipu-coding');
  await page.waitForTimeout(300);
  await page.click('#dlg-ok');
  await page.waitForTimeout(200);
  ok((await page.$eval('#ai-base', el => el.value)) === 'https://open.bigmodel.cn/api/coding/paas/v4', '编程套餐填 coding 端点');
  ok((await page.$eval('#ai-key', el => el.value)) === '', '切换提供商清空旧 Key');

  // 自定义：不动字段、隐藏链接
  await page.fill('#ai-extra', '{"thinking":{"type":"enabled"}}');
  await page.selectOption('#ai-provider', 'custom');
  await page.waitForTimeout(300);
  ok((await page.$eval('#ai-base', el => el.value)) === '', '自定义清空 baseURL');
  ok((await page.$eval('#ai-model', el => el.value)) === '', '自定义清空 model');
  ok((await page.$eval('#ai-key', el => el.value)) === '', '自定义清空 Key');
  ok((await page.$eval('#ai-extra', el => el.value)) === '', '自定义清空附加参数');
  ok(await page.$eval('#ai-key-link', el => el.classList.contains('is-off')), '自定义时获取 Key 按钮置灰');
  ok(await page.$eval('#ai-key-link', el => !el.hidden), '获取 Key 按钮常驻不隐藏');

  await page.screenshot({ path: path.join(__dirname, 'ai-preset-1440.png') });
  await browser.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  server.kill();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
