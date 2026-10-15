'use strict';

/**
 * 二维码正确性交叉验证
 *
 *   node scripts/qrcheck.js
 *
 * 为什么需要这个测试：
 *   lib/qrcode.js 是本项目手写的零依赖二维码编码器（为了不引入 npm 依赖），
 *   二维码一旦编码错误，同学扫码就会失败——比没有二维码更糟。
 *   因此这里用一个**独立实现的解码器**（scripts/qrverify.py，按标准重新实现）
 *   把生成的码解回来，比对内容是否一致，并校验 Reed-Solomon 纠错码字。
 *
 * 依赖 Python 3（仅用于开发期验证，运行时不需要）。
 * 若本机没有 Python，本脚本会跳过并说明原因，不影响程序运行。
 *
 * 可用环境变量 PYTHON 指定解释器路径。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { generateMatrix } = require('../lib/qrcode');

// ---------- 定位 Python ----------

function findPython() {
  if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) return process.env.PYTHON;

  const names = process.platform === 'win32'
    ? ['python.exe', 'python3.exe', 'py.exe']
    : ['python3', 'python'];

  for (const n of names) {
    const r = spawnSync(n, ['--version'], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) return n;
  }
  return null;
}

// ---------- 测试用例 ----------

const CASES = [
  // 各种真实会遇到的地址形态
  'http://192.168.1.2:8080/student',
  'http://10.0.0.5',
  'http://172.16.31.200:80',
  'https://abc.example.edu.cn/student',
  'http://hbuas15.local/student',
  'https://hbuas.edu.cn/community-agent/student?from=kiosk',
  // 边界：极短内容、最长支持内容
  'A',
  'http://' + 'a'.repeat(180),
];

// ---------- 主流程 ----------

(function main() {
  const py = findPython();
  if (!py) {
    console.log('  ! 未找到 Python 3，跳过二维码交叉验证。');
    console.log('    （这只是开发期验证手段，不影响程序运行）');
    console.log('    如需校验：安装 Python 3，或用 PYTHON 环境变量指定解释器路径。');
    process.exit(0);
  }

  const tmpIn = path.join(os.tmpdir(), `qrcheck-in-${process.pid}.json`);
  const tmpOut = path.join(os.tmpdir(), `qrcheck-out-${process.pid}.json`);
  const verifier = path.join(__dirname, 'qrverify.py');

  if (!fs.existsSync(verifier)) {
    console.log('  ! 缺少 scripts/qrverify.py，无法验证。');
    process.exit(1);
  }

  // 生成测试矩阵
  const cases = CASES.map((text) => {
    const m = generateMatrix(text);
    return { text, modules: m.modules, meta: `v${m.version} ${m.size}x${m.size}` };
  });
  fs.writeFileSync(tmpIn, JSON.stringify({ cases }), 'utf8');

  // 交给独立解码器；结果通过文件交换（不依赖 stdout，避免管道限制）
  const res = spawnSync(py, [verifier, tmpIn, tmpOut], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: 'ignore',
  });

  if (!fs.existsSync(tmpOut)) {
    console.log('  ✗ 解码器未产出结果。退出码:', res.status, res.error ? res.error.message : '');
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    process.exit(1);
  }

  const out = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));

  console.log('='.repeat(64));
  console.log('  二维码交叉验证（独立解码器）');
  console.log('='.repeat(64));

  let pass = 0;
  let fail = 0;
  out.results.forEach((r, i) => {
    const label = r.text.length > 46 ? r.text.slice(0, 43) + '...' : r.text;
    if (r.ok) {
      pass++;
      console.log(`  ✓ ${label}`);
      console.log(`      ${r.detail}`);
    } else {
      fail++;
      console.log(`  ✗ ${label}`);
      console.log(`      ${r.detail}`);
    }
  });

  console.log('-'.repeat(64));
  console.log(`  通过 ${pass} / ${pass + fail}`);
  console.log('='.repeat(64));

  if (fail === 0) {
    console.log('\n  所有二维码均可被独立解码，内容与原文一致，RS 纠错校验通过。');
  } else {
    console.log('\n  存在无法正确解码的二维码，请检查 lib/qrcode.js。');
  }

  try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }

  process.exit(fail === 0 ? 0 : 1);
})();
