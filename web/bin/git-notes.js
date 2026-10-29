#!/usr/bin/env node
'use strict';
/* git-notes —— Git笔记 命令行
 *
 * git-notes            确保服务在跑（没跑则后台拉起），然后打开笔记页面
 * git-notes status     查看运行状态 / PID / 版本
 * git-notes stop       停止后台服务
 * git-notes -v         显示版本
 * git-notes help       帮助
 *
 * 环境变量：GN_PORT（默认 8644）、GN_NO_OPEN=1（不自动开浏览器，脚本/测试用）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(PKG_ROOT, 'package.json')).version;
const PORT = Number(process.env.GN_PORT) || 8644;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.homedir(), '.git-notes');
const PID_FILE = path.join(DATA_DIR, 'git-notes.pid');
const LOG_FILE = path.join(DATA_DIR, 'git-notes.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 探测 8644：down=没服务；ours=本服务（带版本/PID）；foreign=端口被其他程序占用 */
function probe() {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/healthz', { timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let info = null;
        try { info = JSON.parse(body); } catch (_) {}
        if (res.statusCode === 200 && info && info.ok) {
          resolve({ kind: 'ours', version: info.version, pid: info.pid });
        } else {
          resolve({ kind: 'foreign' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ kind: 'foreign' }); });
    req.on('error', (e) => {
      resolve(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? { kind: 'down' } : { kind: 'foreign' });
    });
  });
}

function staleCheck(info) {
  if (info.version && info.version !== VERSION) {
    console.warn(`[warn] 运行中的服务是旧版本 v${info.version}（CLI 为 v${VERSION}）。执行 git-notes stop 后再执行 git-notes 可更新。`);
  }
}

function openBrowser(url) {
  if (process.env.GN_NO_OPEN === '1') return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) {
    /* 打不开不影响服务 */
  }
}

async function startService() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(PKG_ROOT, 'server.js')], {
    cwd: PKG_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  fs.closeSync(out);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const p = await probe();
    if (p.kind === 'ours') return p;
    if (p.kind === 'foreign') throw new Error(`端口 ${PORT} 被其他程序占用，可用 GN_PORT=<端口> 换端口`);
  }
  throw new Error('服务启动超时（可能缺少 git），请查看日志 ' + LOG_FILE);
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch (_) { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

/* Windows 上 detached 的 node 收不到 SIGTERM，kill 无效时用 taskkill 强杀 */
function forceKill(pid) {
  try { process.kill(pid); } catch (_) {}
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' }); } catch (_) {}
  }
}

async function cmdDefault() {
  const p = await probe();
  if (p.kind === 'ours') {
    staleCheck(p);
    console.log('服务已在运行：' + BASE);
  } else if (p.kind === 'down') {
    console.log('启动 git-notes 服务…');
    const info = await startService();
    staleCheck(info);
    console.log('服务已启动：' + BASE);
  } else {
    console.error(`[error] 端口 ${PORT} 已被其他程序占用。可用 GN_PORT=<端口> 换端口后重试。`);
    process.exit(1);
  }
  openBrowser(BASE);
}

async function cmdStatus() {
  const p = await probe();
  if (p.kind === 'ours') {
    console.log(`运行中：${BASE}`);
    if (p.version !== VERSION) {
      console.log(`  版本 v${p.version}（CLI 为 v${VERSION}，建议 git-notes stop 后再启动以更新）`);
    } else {
      console.log(`  版本 v${p.version}`);
    }
    if (p.pid) console.log(`  PID ${p.pid}`);
    console.log(`  日志 ${LOG_FILE}`);
  } else if (p.kind === 'down') {
    console.log('未在运行。');
    const pf = readPidFile();
    if (pf && pidAlive(pf.pid)) console.log(`[warn] 发现残留 pid 记录（${pf.pid}），可执行 git-notes stop 清理。`);
  } else {
    console.log(`端口 ${PORT} 被其他程序占用（非本服务）。`);
  }
}

async function cmdStop() {
  const pf = readPidFile();
  if (pf && pidAlive(pf.pid)) {
    forceKill(pf.pid);
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if ((await probe()).kind === 'down') break;
    }
    const cur = readPidFile();
    if (cur && cur.pid === pf.pid) { try { fs.unlinkSync(PID_FILE); } catch (_) {} }
    console.log('服务已停止（PID ' + pf.pid + '）。');
  } else {
    if (pf) { try { fs.unlinkSync(PID_FILE); } catch (_) {} }
    const p = await probe();
    if (p.kind === 'ours') console.log('服务在运行但无 pid 记录（非本工具托管），请在其终端 Ctrl+C 停止。');
    else if (p.kind === 'down') console.log('服务未在运行。');
    else console.log(`端口 ${PORT} 被其他程序占用，非本服务，未做处理。`);
  }
}

const arg = process.argv[2];
(async () => {
  if (arg === 'status') return cmdStatus();
  if (arg === 'stop') return cmdStop();
  if (arg === '-v' || arg === '--version') return console.log('git-notes v' + VERSION);
  if (arg === 'help' || arg === '-h' || arg === '--help') {
    console.log([
      'git-notes —— Git笔记：本地 git 仓库架构的微笔记',
      '  git-notes            启动（如未运行）并打开笔记页面',
      '  git-notes status     查看运行状态',
      '  git-notes stop       停止后台服务',
      '  git-notes -v         显示版本',
      '  git-notes help       本帮助',
      '',
      `数据目录：${DATA_DIR}（本地仓库、SSH 密钥、pid 与日志）`,
      '两种模式：仅本机使用（无需任何远端）；绑定任意远端 git 服务器后自动同步。',
    ].join('\n'));
    return;
  }
  if (arg === undefined) return cmdDefault();
  console.error('未知命令：' + arg + '（git-notes help 查看用法）');
  process.exit(1);
})().catch((e) => {
  console.error('[error] ' + e.message);
  process.exit(1);
});
