'use strict';

/**
 * 零依赖 QR 码生成器（Byte 模式，纠错等级 M，版本 1-10 自动选择）
 *
 * 为什么自己写：本项目承诺「零依赖」，而 npm 的 qrcode 包会引入若干传递依赖。
 * 一体机可能无外网，npm install 不一定可用，所以这里内置一个够用的实现。
 *
 * 用途：一体机大屏显示二维码，同学扫码即可在手机上打开学生端。
 *
 * 参考标准：ISO/IEC 18004。仅实现 Byte（8-bit）模式，
 * 足以编码 URL（ASCII），无需支持汉字/数字等其它模式。
 */

// ---------- GF(256) 伽罗华域运算（用于 Reed-Solomon 纠错） ----------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 生成 RS 生成多项式 */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 计算纠错码字 */
function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecCount; i++) {
      res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

// ---------- 版本参数表（版本 1-10，纠错等级 M） ----------
// 每项：[每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]
const VERSION_M = {
  1:  [10, 1, 16, 0, 0],
  2:  [16, 1, 28, 0, 0],
  3:  [26, 1, 44, 0, 0],
  4:  [18, 2, 32, 0, 0],
  5:  [24, 2, 43, 0, 0],
  6:  [16, 4, 27, 0, 0],
  7:  [18, 4, 31, 0, 0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/** 数据码字总容量 */
function dataCapacity(version) {
  const [, b1, d1, b2, d2] = VERSION_M[version];
  return b1 * d1 + b2 * d2;
}

/** 各版本的对齐图案中心坐标 */
const ALIGN_POS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** 版本信息（版本 ≥ 7 需要） */
const VERSION_INFO = {
  7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3,
};

// ---------- 编码 ----------

/** 选择能容纳 dataLength 字节的最小版本 */
function chooseVersion(dataLength) {
  for (let v = 1; v <= 10; v++) {
    const cap = dataCapacity(v);
    // 头部：模式(4) + 长度指示符(8 或 16) 折算成字节
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    const needBits = headerBits + dataLength * 8;
    if (needBits <= cap * 8) return v;
  }
  throw new Error('内容过长，超出本实现支持范围（版本 10 / 纠错 M 上限约 213 字节）');
}

/** 把字节数据编码为码字序列（含纠错） */
function encodeData(bytes, version) {
  const [, b1, d1, b2, d2] = VERSION_M[version];
  const ecPerBlock = VERSION_M[version][0];
  const totalData = b1 * d1 + b2 * d2;

  // --- 比特流 ---
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  push(0b0100, 4);                                   // Byte 模式
  push(bytes.length, version <= 9 ? 8 : 16);         // 长度
  for (const b of bytes) push(b, 8);

  // 终止符（最多 4 个 0）
  const capBits = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);

  // 填充码字 0xEC / 0x11 交替
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < capBits) {
    push(padBytes[padIdx++ % 2], 8);
  }

  // --- 转成码字 ---
  const dataWords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataWords.push(byte);
  }

  // --- 分块 + 纠错 ---
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < b1; i++) {
    const d = dataWords.slice(offset, offset + d1);
    offset += d1;
    blocks.push({ data: d, ec: rsEncode(d, ecPerBlock) });
  }
  for (let i = 0; i < b2; i++) {
    const d = dataWords.slice(offset, offset + d2);
    offset += d2;
    blocks.push({ data: d, ec: rsEncode(d, ecPerBlock) });
  }

  // --- 交织 ---
  const result = [];
  const maxData = Math.max(d1, d2 || 0);
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) {
      if (i < blk.data.length) result.push(blk.data[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const blk of blocks) result.push(blk.ec[i]);
  }

  return result;
}

// ---------- 矩阵构建 ----------

function createMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  return { size, m };
}

/** 放定位图案（三个角） */
function placeFinder(m, size) {
  const put = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = (inRing || inCore) ? 1 : 0;
      }
    }
  };
  put(0, 0);
  put(0, size - 7);
  put(size - 7, 0);
}

/** 放对齐图案 */
function placeAlign(m, size, version) {
  const pos = ALIGN_POS[version];
  for (const r0 of pos) {
    for (const c0 of pos) {
      // 跳过与定位图案重叠的位置
      if ((r0 <= 8 && c0 <= 8) || (r0 <= 8 && c0 >= size - 9) || (r0 >= size - 9 && c0 <= 8)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const isEdge = Math.abs(r) === 2 || Math.abs(c) === 2;
          const isCenter = r === 0 && c === 0;
          m[r0 + r][c0 + c] = (isEdge || isCenter) ? 1 : 0;
        }
      }
    }
  }
}

/** 放定时图案 */
function placeTiming(m, size) {
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === null) m[6][i] = v;
    if (m[i][6] === null) m[i][6] = v;
  }
}

/** 预留格式信息区（先填 0，稍后写真实值） */
function reserveFormat(m, size) {
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
  }
  m[size - 8][8] = 1;   // 固定暗模块
}

/** 预留版本信息区（版本 ≥ 7） */
function reserveVersion(m, size, version) {
  if (version < 7) return;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      if (m[size - 11 + j][i] === null) m[size - 11 + j][i] = 0;
      if (m[i][size - 11 + j] === null) m[i][size - 11 + j] = 0;
    }
  }
}

/** 掩码函数 */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 放置数据位（含掩码） */
function placeData(m, size, codewords, maskIdx) {
  const maskFn = MASKS[maskIdx];
  let bitIdx = 0;
  const totalBits = codewords.length * 8;

  const getBit = (i) => {
    if (i >= totalBits) return 0;
    return (codewords[i >> 3] >> (7 - (i & 7))) & 1;
  };

  // 从右下角开始，两列一组，蛇形向上
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;   // 跳过定时列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m[row][c] !== null) continue;
        let bit = getBit(bitIdx++);
        if (maskFn(row, c)) bit ^= 1;
        m[row][c] = bit;
      }
    }
    upward = !upward;
  }
}

/**
 * 计算格式信息并写入。
 *
 * 位序说明（这是整个实现最容易错的地方）：
 *   15 位格式信息中，第 14 位（最高位）是纠错等级的最高位，第 0 位是最低位。
 *   写入矩阵时按「从高位到低位」依次填入固定的模块位置。
 *
 * 之前版本把「最低位」写到了第一个位置，导致解码方读出的掩码号与实际不符，
 * 于是按错误掩码还原整个数据区，RS 校验必然失败、解出的模式也不是 0100。
 */
function writeFormat(m, size, maskIdx) {
  // 纠错等级 M = 0b00
  const data = (0b00 << 3) | maskIdx;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  const format = ((data << 10) | (rem & 0x3ff)) ^ 0x5412;

  // f(k)：k = 0 取最高位（第 14 位），k = 14 取最低位（第 0 位）
  const f = (k) => (format >> (14 - k)) & 1;

  // ---- 第一份：围绕左上定位图案 ----
  m[8][0] = f(0); m[8][1] = f(1); m[8][2] = f(2); m[8][3] = f(3);
  m[8][4] = f(4); m[8][5] = f(5);
  m[8][7] = f(6); m[8][8] = f(7);          // 跳过第 6 列（定时图案）
  m[7][8] = f(8);
  m[5][8] = f(9); m[4][8] = f(10); m[3][8] = f(11);   // 跳过第 6 行
  m[2][8] = f(12); m[1][8] = f(13); m[0][8] = f(14);

  // ---- 第二份：左下（垂直）+ 右上（水平）----
  for (let k = 0; k <= 6; k++) m[size - 1 - k][8] = f(k);
  for (let k = 7; k <= 14; k++) m[8][size - 15 + k] = f(k);

  // 固定暗模块
  m[size - 8][8] = 1;
}

/** 写入版本信息（版本 ≥ 7） */
function writeVersionInfo(m, size, version) {
  if (version < 7) return;
  const info = VERSION_INFO[version];
  for (let i = 0; i < 18; i++) {
    const bit = (info >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = bit;
    m[r][size - 11 + c] = bit;
  }
}

/** 掩码惩罚分（用于选择最优掩码） */
function penalty(m, size) {
  let score = 0;

  // 规则 1：同色连续 ≥5
  for (let i = 0; i < size; i++) {
    for (const isRow of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = isRow ? m[i][j] : m[j][i];
        const prev = isRow ? m[i][j - 1] : m[j - 1][i];
        if (cur === prev) { run++; }
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // 规则 2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // 规则 3：形如 1:1:3:1:1 的图案
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      let m1 = true, m2 = true, m3 = true, m4 = true;
      for (let k = 0; k < 11; k++) {
        if (m[i][j + k] !== pat1[k]) m1 = false;
        if (m[i][j + k] !== pat2[k]) m2 = false;
        if (m[j + k][i] !== pat1[k]) m3 = false;
        if (m[j + k][i] !== pat2[k]) m4 = false;
      }
      if (m1) score += 40;
      if (m2) score += 40;
      if (m3) score += 40;
      if (m4) score += 40;
    }
  }

  // 规则 4：暗色比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

// ---------- 对外接口 ----------

/**
 * 生成 QR 矩阵
 * @param {string} text 要编码的内容（建议为 ASCII URL）
 * @returns {{ size: number, modules: number[][] }}
 */
function generateMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  const version = chooseVersion(bytes.length);
  const codewords = encodeData(bytes, version);

  const { size, m } = createMatrix(version);
  placeFinder(m, size);
  placeAlign(m, size, version);
  placeTiming(m, size);
  reserveFormat(m, size);
  reserveVersion(m, size, version);

  // 记录功能模块位置，用于尝试各掩码
  const base = m.map((row) => row.slice());

  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;

  for (let mask = 0; mask < 8; mask++) {
    const trial = base.map((row) => row.slice());
    placeData(trial, size, codewords, mask);
    writeFormat(trial, size, mask);
    writeVersionInfo(trial, size, version);
    const p = penalty(trial, size);
    if (p < bestScore) { bestScore = p; best = trial; bestMask = mask; }
  }

  return { size, modules: best, version, mask: bestMask };
}

/** 生成 SVG 字符串 */
function toSVG(text, opts = {}) {
  const { size, modules } = generateMatrix(text);
  const quiet = opts.quiet == null ? 4 : opts.quiet;     // 静默区
  const scale = opts.scale || 8;
  const total = (size + quiet * 2) * scale;
  const dark = opts.dark || '#143a23';
  const light = opts.light || '#ffffff';

  const rects = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      rects.push(
        `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<g fill="${dark}">${rects.join('')}</g></svg>`;
}

module.exports = { generateMatrix, toSVG };
