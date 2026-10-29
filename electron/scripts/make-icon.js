// 生成应用图标 build/icon.ico：把 web/index.html 顶栏的笔记本 logo（lucide 描边 SVG）
// 渲染成多尺寸 PNG（256/64/48/32/16），再打包为 PNG-in-ICO（Vista+ 原生支持，无需第三方库）。
// 用法：NODE_PATH=<全局 node_modules> node scripts/make-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

/* 与 web/assets/icon.svg 同源：G + 笔记本（纸白圆角底 + git 橙 #FF4F2E 描边）；
   favicon（index.html data URI）与安卓 ic_launcher_fg.xml 同一图形 */
const LOGO_SVG = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" rx="45" fill="#ffffff"/><g fill="none" stroke="#FF4F2E" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"><path d="M 80 40 L 120 40 Q 140 40 140 60 L 140 90"/><path d="M 140 120 L 140 140 Q 140 160 120 160 L 80 160 Q 60 160 60 140 L 60 60 Q 60 40 80 40"/><path d="M 140 120 L 90 120"/><path d="M 42 65 L 60 65"/><path d="M 42 100 L 60 100"/><path d="M 42 135 L 60 135"/></g></svg>`;
const SIZES = [256, 64, 48, 32, 16];
const DEST = path.join(__dirname, '..', 'icons', 'icon.ico');

function packIco(pngs /* [{size, buf}] */) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           /* reserved */
  header.writeUInt16LE(1, 2);           /* type: icon */
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);   /* width, 0 = 256 */
    e.writeUInt8(size === 256 ? 0 : size, 1);   /* height */
    e.writeUInt8(0, 2);                 /* palette */
    e.writeUInt8(0, 3);                 /* reserved */
    e.writeUInt16LE(1, 4);              /* color planes */
    e.writeUInt16LE(32, 6);             /* bits per pixel */
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pngs = [];
  for (const size of SIZES) {
    /* LOGO_SVG 自带纸白圆角底（rx 45/200），整幅渲染、圆角外透明 */
    const html = `<!doctype html><html><body style="margin:0;background:transparent">
      <div id="ic" style="width:${size}px;height:${size}px">${LOGO_SVG}</div>
      </body></html>`;
    await page.setContent(html);
    await page.setViewportSize({ width: size, height: size });
    const el = await page.$('#ic');
    const buf = await el.screenshot({ omitBackground: true });
    pngs.push({ size, buf });
    console.log('[icon]', size, 'px =', buf.length, 'bytes');
  }
  await browser.close();
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, packIco(pngs));
  console.log('[icon] written:', DEST);
})().catch((e) => { console.error('[icon] FAIL:', e.message); process.exit(1); });
