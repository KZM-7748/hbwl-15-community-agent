'use strict';

/**
 * 编码完整性检查
 *
 *   node scripts/encodingcheck.js
 *
 * 为什么需要这个检查：
 *   本项目全部文本文件使用 UTF-8 编码（含大量中文）。
 *   在 Windows 上用 PowerShell 的 Get-Content / Set-Content 编辑这些文件时，
 *   若不显式指定 -Encoding UTF8，很容易把 UTF-8 当成 GBK 读写，
 *   导致中文变成「瀛︾敓绔」这类乱码，且往往到页面显示异常时才发现。
 *
 *   例外：启动.bat 刻意使用 GBK 编码——Windows 批处理的原生编码，
 *   用 UTF-8 会导致中文乱码甚至脚本执行出错。
 *
 * 检查内容：
 *   1. 文件是否为合法 UTF-8（字节可无损往返）
 *   2. 是否含替换字符 U+FFFD（非法字节序列的标志）
 *   3. 是否含常见乱码特征串
 *   4. 抽样确认中文能被正确读出
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 注意：包含 .bat，否则「跳过 GBK 文件」的判断永远不会触发，
// 将来新增的批处理文件若编码写错也不会被发现。
const EXT = new Set(['.html', '.css', '.js', '.json', '.md', '.txt', '.py', '.yml', '.bat', '.cmd']);

// 刻意使用 GBK 编码的文件，跳过 UTF-8 检查
const GBK_FILES = new Set(['启动.bat']);

// 本文件自身包含乱码样本，跳过（否则会自我命中）
const SELF = 'encodingcheck.js';

// 乱码特征：UTF-8 字节被当 GBK 解码后常见的字符组合
const MOJIBAKE = ['瀛︾', '鏍嬩', '绀惧', '鏅鸿', '锛?', '鐨?', '涓€', '绔欏', '璁＄', '\uFFFD'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '_logs') continue;
      walk(p, out);
    } else if (EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(ROOT);
let bad = 0;
let checked = 0;
const skipped = [];

console.log('='.repeat(64));
console.log('  编码完整性检查（UTF-8）');
console.log('='.repeat(64));

for (const f of files) {
  const rel = f.replace(ROOT + path.sep, '');

  if (GBK_FILES.has(rel)) { skipped.push(rel + '（刻意使用 GBK）'); continue; }
  if (rel.endsWith(SELF)) { skipped.push(rel + '（含检测样本）'); continue; }

  const buf = fs.readFileSync(f);
  const text = buf.toString('utf8');
  const utf8Ok = Buffer.from(text, 'utf8').equals(buf);
  const hasReplacement = text.includes('\uFFFD');
  const hits = MOJIBAKE.filter((m) => m !== '\uFFFD' && text.includes(m));

  checked++;
  if (!utf8Ok || hasReplacement || hits.length) {
    bad++;
    console.log(`  ✗ ${rel}`);
    if (!utf8Ok) console.log('      不是合法 UTF-8');
    if (hasReplacement) console.log('      含替换字符 U+FFFD');
    if (hits.length) console.log('      含乱码特征: ' + hits.join(' '));
  }
}

console.log('-'.repeat(64));
console.log(`  检查 ${checked} 个文件，异常 ${bad} 个`);
if (skipped.length) {
  console.log('  已跳过：');
  for (const s of skipped) console.log(`    · ${s}`);
}

// 抽样确认中文可正常读取
console.log('\n  抽样验证（确认中文正常）：');
const samples = [
  ['data/_config.json', /"siteName"/],
  ['public/student.html', /<title>/],
  ['lib/agent.js', /社区/],
  ['README.md', /湖北文理学院/],
  ['data/faq.json', /"question"/],
];
for (const [rel, re] of samples) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log(`    - ${rel} 不存在`); continue; }
  const t = fs.readFileSync(p, 'utf8');
  const line = t.split('\n').find((l) => re.test(l));
  if (!line) { console.log(`    ✗ ${rel} 未找到预期内容`); continue; }
  // 确认该行不含乱码
  const dirty = MOJIBAKE.some((m) => line.includes(m));
  console.log(`    ${dirty ? '✗' : '✓'} ${rel}: ${line.trim().slice(0, 68)}`);
}

console.log('='.repeat(64));
if (bad === 0) {
  console.log('  全部正常。');
} else {
  console.log(`  ${bad} 个文件编码异常，请用 UTF-8 重新保存。`);
  console.log('  提示：用 PowerShell 写文件时务必加 -Encoding UTF8，');
  console.log('        或直接用编辑器的「以 UTF-8 保存」。');
}
console.log('='.repeat(64));

process.exit(bad === 0 ? 0 : 1);

