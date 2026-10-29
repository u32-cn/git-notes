// 构建时把 ../web/ 前端拷入 build/（对齐 android 的 generated assets 模式，前端零分叉）：
// index.html + assets/ + js/ 进 build/，pinyin-data.js 进 backend/（Node require 的共享拼音数据）。
'use strict';
const fs = require('fs');
const path = require('path');

const web = path.join(__dirname, '..', '..', 'web');
const build = path.join(__dirname, '..', 'build');
const backend = path.join(__dirname, '..', 'backend');

fs.mkdirSync(build, { recursive: true });
fs.copyFileSync(path.join(web, 'index.html'), path.join(build, 'index.html'));
fs.copyFileSync(path.join(web, 'help.html'), path.join(build, 'help.html'));

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(destDir, f));
  }
}
copyDir(path.join(web, 'assets'), path.join(build, 'assets'));
copyDir(path.join(web, 'js'), path.join(build, 'js'));
fs.copyFileSync(path.join(web, 'pinyin-data.js'), path.join(backend, 'pinyin-data.js'));
/* 构建溯源（AGENTS.md 规则：先提交再打包）：把源码仓库最新 commit+时间注入 assets/version.json，
   设置页「本地仓库」区块读取展示。放在 copyDir 之后避免被源目录拷贝覆盖。 */
(function injectVersion() {
  const repoRoot = path.join(__dirname, '..', '..');
  let v = { commit: '', time: '', subject: '' };
  try {
    const { execSync } = require('child_process');
    const opts = { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const src = execSync('git log -1 --format=%h%n%cI%n%s', opts).trim().split('\n');
    v = { commit: src[0] || '', time: src[1] || '', subject: src[2] || '' };
  } catch (e) {
    console.warn('[copy-web] WARN: git 版本注入失败:', e.message.split('\n')[0]);
  }
  if (!v.commit) throw new Error('version 注入失败：请先 git 提交再打包（AGENTS.md 打包规则）');
  fs.writeFileSync(path.join(build, 'assets', 'version.json'), JSON.stringify(v));
  console.log('[copy-web] version.json:', v.commit, v.time);
})();
console.log('[copy-web] web/ -> build/ + backend/pinyin-data.js');
