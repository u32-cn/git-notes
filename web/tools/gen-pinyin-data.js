// 生成 web/pinyin-data.js（汉字→拼音紧凑表）与 android 端 PinyinData.kt。
// 用法：node web/tools/gen-pinyin-data.js <pinyin.txt> <china8105.txt>
// 数据源：mozillazg/pinyin-data（pinyin.txt 全量读音 + 通用规范汉字表 8105 字白名单）。
// 每字取第一读音（kMandarin 最常用读）、去声调、小写；按韵母分组压缩成单字符串，
// 形如 "a阿啊ai爱哀…"（连续 [a-z]+ 为音节，其后非 ASCII 字符均为该音节字）。
// 三端（web/server.js、electron/backend/store.js、android PinyinData.kt）共用同一 PY_GROUPS 字符串；
// 重新生成后必须三处同步替换。
'use strict';
const fs = require('fs');
const path = require('path');

const [, , pinyinFile, charsFile] = process.argv;
if (!pinyinFile || !charsFile) {
  console.error('用法: node gen-pinyin-data.js <pinyin.txt> <china8105.txt>');
  process.exit(1);
}

/* 去声调：按 Unicode 声调组合字符映射回基础字母（ü 特殊处理为 v） */
function stripTone(s) {
  const map = { 'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a', 'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e', 'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i', 'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o', 'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u', 'ǖ': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v', 'ü': 'v', 'ń': 'n', 'ň': 'n', 'ǹ': 'n', 'ḿ': 'm' };
  return s.toLowerCase().split('').map((c) => map[c] || c).join('');
}

// 常用字白名单
const common = new Set();
fs.readFileSync(charsFile, 'utf8').split(/\r?\n/).forEach((line) => {
  const m = /^U\+(\S+)\t/.exec(line);
  if (!m) return;
  const cp = parseInt(m[1], 16);
  if (cp <= 0xffff) common.add(String.fromCodePoint(cp));
  // 扩展 B 区字（U+2CE93 等）在笔记中极罕见，跳过以保持单字符串可按 charCodeAt 解析
});

// 字 → 首读音
const charPy = new Map();
fs.readFileSync(pinyinFile, 'utf8').split(/\r?\n/).forEach((line) => {
  const m = /^U\+(\S+):\s*(\S+)/.exec(line);
  if (!m) return;
  const cp = parseInt(m[1], 16);
  if (cp > 0xffff) return;
  const ch = String.fromCodePoint(cp);
  if (!common.has(ch) || charPy.has(ch)) return;
  const py = stripTone(m[2].split(',')[0]);
  if (/^[a-z]{1,6}$/.test(py)) charPy.set(ch, py);
});

// 按音节分组（组内按 Unicode 序，保证生成结果确定性）
const groups = new Map();
[...charPy.keys()].sort().forEach((ch) => {
  const py = charPy.get(ch);
  if (!groups.has(py)) groups.set(py, []);
  groups.get(py).push(ch);
});
const syllables = [...groups.keys()].sort();
const PY_GROUPS = syllables.map((py) => py + groups.get(py).join('')).join('');

const stats = { chars: charPy.size, syllables: syllables.length, bytes: Buffer.byteLength(PY_GROUPS, 'utf8') };
console.log('统计:', JSON.stringify(stats));

// 折行输出（每 100 组一行）便于人读与 diff
function wrapped(s) {
  const parts = [];
  const re = /[a-z]+[^\x00-\x7f]*/g;
  let m, line = '';
  while ((m = re.exec(s))) {
    if (line.length + m[0].length > 900) { parts.push(line); line = ''; }
    line += m[0];
  }
  if (line) parts.push(line);
  return parts;
}

// ---- web/pinyin-data.js ----
const jsLines = wrapped(PY_GROUPS).map((l) => "  '" + l + "'");
const jsOut = `// 汉字→拼音紧凑数据（音节分组单字符串），由 web/tools/gen-pinyin-data.js 生成，勿手改。
// 数据源 mozillazg/pinyin-data + 通用规范汉字表 8105 字（每字取首读音、去声调）。
// 三端同步义务：本文件被 web/server.js require；electron/backend/pinyin-data.js 与
// android PinyinData.kt 的 PY_GROUPS 必须与本文件内容一致（重新生成后三处同换）。
'use strict';

const PY_GROUPS = [
${jsLines.join(',\n')},
].join('');

/* 解析分组串 → { 字: 音节 } 映射 */
function buildCharPinyin() {
  const map = {};
  const re = /([a-z]+)([^\\x00-\\x7f]+)/g;
  let m;
  while ((m = re.exec(PY_GROUPS))) {
    const py = m[1];
    for (const ch of m[2]) if (!(ch in map)) map[ch] = py;
  }
  return map;
}

module.exports = { PY_GROUPS, buildCharPinyin };
`;
fs.writeFileSync(path.join(__dirname, '..', 'pinyin-data.js'), jsOut);

// ---- android PinyinData.kt ----
const ktLines = wrapped(PY_GROUPS).map((l) => '        "' + l + '" +');
const ktOut = `package com.vtxf.gitnotes

// 汉字→拼音紧凑数据（音节分组单字符串），由 web/tools/gen-pinyin-data.js 生成，勿手改。
// 数据源 mozillazg/pinyin-data + 通用规范汉字表 8105 字（每字取首读音、去声调）。
// 三端同步义务：web/pinyin-data.js 与 electron/backend/pinyin-data.js 的 PY_GROUPS
// 必须与本文件的 PY_GROUPS 内容一致（重新生成后三处同换）。
object PinyinData {
    val PY_GROUPS: String =
${ktLines.join('\n')}
        ""

    /** 解析分组串 → 汉字→音节映射（首次访问时构建） */
    val charPinyin: Map<String, String> by lazy {
        val map = HashMap<String, String>()
        val re = Regex("([a-z]+)([^\\\\x00-\\\\x7f]+)")
        re.findAll(PY_GROUPS).forEach { m ->
            val py = m.groupValues[1]
            m.groupValues[2].forEach { ch ->
                val key = ch.toString()
                if (key !in map) map[key] = py
            }
        }
        map
    }
}
`;
const ktPath = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java', 'com', 'vtxf', 'gitnotes', 'PinyinData.kt');
fs.writeFileSync(ktPath, ktOut);
console.log('已生成:', path.join(__dirname, '..', 'pinyin-data.js'));
console.log('已生成:', ktPath);
