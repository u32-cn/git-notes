// 发布更新源到 OSS：
//   默认（win）：把 dist/latest.yml + dist/git-notes-<版本>-setup.exe 推到 update/win/（electron 自动更新拉 latest.yml）
//   --platform android：把 android/dist/git-notes-v<版本>.apk + 生成的 latest.json 推到 update/android/（安卓 /api/update/check 拉 latest.json）
// 对应公开地址 https://u32.cn/bd/apps/git-notes/update/<platform>/。
// 用法：win 先 npm run dist；android 先 cd android && gradlew.bat assembleRelease；再 node scripts/release-oss.js [--platform android]
// 凭证：环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（缺省回退 ~/.ossutilconfig），
// 严禁把密钥写进本仓库。上传走 npx aliyun-cli-npm 的 oss 子命令（见 rules/office/aliyun.md）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BUCKET = 'u32-cn-data';
const ENDPOINT = 'oss-cn-beijing.aliyuncs.com';
const BASE = '_inner_/bigdata/apps/git-notes/update/';

function loadCreds() {
  if (process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET) {
    return { id: process.env.OSS_ACCESS_KEY_ID, secret: process.env.OSS_ACCESS_KEY_SECRET };
  }
  /* 回退：ossutil 标准配置（本机已有，单一事实源，不入 git） */
  const cfg = path.join(os.homedir(), '.ossutilconfig');
  if (fs.existsSync(cfg)) {
    const txt = fs.readFileSync(cfg, 'utf8');
    const get = (k) => (txt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
    const id = get('accessKeyID') && get('accessKeyID').trim();
    const secret = get('accessKeySecret') && get('accessKeySecret').trim();
    if (id && secret) return { id, secret };
  }
  console.error('缺少凭证：设置 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（或存在 ~/.ossutilconfig）');
  process.exit(1);
}

function parseLatestYml(yml) {
  const version = (yml.match(/^version:\s*(\S+)/m) || [])[1];
  const sha512 = (yml.match(/sha512:\s*(\S+)/) || [])[1];
  const url = (yml.match(/-\s*url:\s*(\S+)/) || [])[1];
  if (!version || !sha512 || !url) throw new Error('latest.yml 解析失败（version/sha512/url）');
  return { version, sha512, url };
}

function ossCp(creds, local, remoteKey, extra) {
  const target = 'oss://' + BUCKET + '/' + PREFIX + remoteKey;
  const args = ['-y', 'aliyun-cli-npm', 'oss', 'cp', local, target,
    '-e', ENDPOINT, '--access-key-id', creds.id, '--access-key-secret', creds.secret, '-f'];
  if (extra) args.push(...extra);
  const r = spawnSync('npx', args, { stdio: ['ignore', 'pipe', 'inherit'], shell: true });
  if (r.status !== 0) throw new Error('上传失败：' + remoteKey + '（exit ' + r.status + '）');
  console.log('[oss] 已上传 ' + remoteKey + (extra ? ' ' + extra.join(' ') : ''));
}

async function verify(latest, manifestName) {
  /* 核验 1：线上更新清单版本与 sha512 一致（EdgeOne CDN 可能缓存旧版，轮询等待） */
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    const res = await fetch(PUBLIC_BASE + manifestName);
    const txt = res.ok ? await res.text() : '';
    const got = manifestName === 'latest.yml'
      ? (txt.match(/^version:\s*(\S+)/m) || [])[1]
      : (() => { try { return JSON.parse(txt).version; } catch { return null; } })();
    if (res.ok && got && got === latest.version) {
      let sha = null;
      if (manifestName === 'latest.yml') sha = (txt.match(/sha512:\s*(\S+)/) || [])[1];
      else { try { sha = JSON.parse(txt).sha512; } catch { /* 不可达 */ } }
      if (sha !== latest.sha512) throw new Error('线上 ' + manifestName + ' sha512 与本地不一致，请检查！');
      console.log('[verify] ' + manifestName + ' ✓ version=' + latest.version + ' sha512 一致');
      break;
    }
    if (Date.now() > deadline) {
      throw new Error('5 分钟内线上 ' + manifestName + ' 未更新到 ' + latest.version + '（CDN 缓存未过期），稍后手动核验 ' + PUBLIC_BASE + manifestName);
    }
    console.log('[verify] 线上仍为 ' + (got || '(不可达)') + '，等 CDN 缓存过期…');
    await new Promise((r) => setTimeout(r, 30 * 1000));
  }
  /* 核验 2：安装包可访问（android 的 url 是绝对地址） */
  const head = await fetch(/^https?:/.test(latest.url) ? latest.url : PUBLIC_BASE + latest.url, { method: 'HEAD' });
  if (!head.ok) throw new Error('安装包 HEAD ' + head.status + '：' + latest.url);
  console.log('[verify] ' + latest.url + ' ✓ HTTP ' + head.status);
}

let PREFIX;
let PUBLIC_BASE;

(async () => {
  const platform = process.argv.includes('--platform') ? process.argv[process.argv.indexOf('--platform') + 1] : 'win';
  if (platform !== 'win' && platform !== 'android') { console.error('未知平台：' + platform); process.exit(1); }
  PREFIX = BASE + platform + '/';
  PUBLIC_BASE = 'https://u32.cn/bd/apps/git-notes/update/' + platform + '/';
  const repoRoot = path.join(__dirname, '..', '..');

  let latest;
  let pkgPath;
  let manifestPath;
  if (platform === 'win') {
    const dist = path.join(__dirname, '..', 'dist');
    manifestPath = path.join(dist, 'latest.yml');
    if (!fs.existsSync(manifestPath)) { console.error('未找到 ' + manifestPath + '，先 npm run dist'); process.exit(1); }
    latest = parseLatestYml(fs.readFileSync(manifestPath, 'utf8'));
    pkgPath = path.join(dist, latest.url);
  } else {
    /* 安卓：APK 由 gradlew 产出，latest.json 现场生成（version 取 web/package.json，sha512 现算） */
    const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'web', 'package.json'), 'utf8')).version;
    /* url 必须是绝对地址：安卓旧包 installUpdate 直接 new URL(url)，不会相对解析 */
    latest = {
      version,
      url: 'https://u32.cn/bd/apps/git-notes/update/android/git-notes-v' + version + '.apk',
      file: 'git-notes-v' + version + '.apk',
    };
    pkgPath = path.join(repoRoot, 'android', 'dist', latest.file);
    if (!fs.existsSync(pkgPath)) { console.error('未找到 ' + pkgPath + '，先 cd android && gradlew.bat assembleRelease'); process.exit(1); }
    latest.sha512 = crypto.createHash('sha512').update(fs.readFileSync(pkgPath)).digest('hex');
    manifestPath = path.join(os.tmpdir(), 'gn-android-latest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: latest.version, url: latest.url, sha512: latest.sha512 }, null, 2) + '\n');
  }
  if (!fs.existsSync(pkgPath)) { console.error('未找到安装包 ' + pkgPath); process.exit(1); }
  console.log('[release] v' + latest.version + '  ' + latest.url + '  (' + Math.round(fs.statSync(pkgPath).size / 1048576) + ' MB)');

  const creds = loadCreds();
  ossCp(creds, pkgPath, latest.file || latest.url);
  /* 更新清单最后传（更新开关，安装包就位后再放行）；必须 no-cache——EdgeOne CDN 缓存旧版会延迟用户收到更新 */
  const manifestName = platform === 'android' ? 'latest.json' : 'latest.yml';
  ossCp(creds, manifestPath, manifestName, ['--meta', 'Cache-Control:no-cache,max-age=0']);
  await verify(latest, manifestName);
  console.log('[release] v' + latest.version + ' 更新源发布完成：' + PUBLIC_BASE);
})().catch((e) => { console.error('[release] ' + (e.message || e)); process.exit(1); });
