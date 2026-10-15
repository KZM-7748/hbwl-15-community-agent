#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立 QR 解码验证器（批量模式）

沙箱环境下 Node 无法捕获 Python 子进程的 stdout（命名管道受限），
因此这里把结果写入文件，由 Node 读取。

用法: python _qrverify.py <输入json> <输出json>
输入: {"cases": [{"text": "...", "modules": [[0,1,...],...]}, ...]}
输出: {"results": [{"text":..., "ok":bool, "detail":"..."}, ...]}
"""

import sys, json, io

# Windows 控制台默认 GBK，print 非 ASCII 会抛异常，这里统一用 UTF-8
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ---------- GF(256) ----------
EXP = [0] * 512
LOG = [0] * 256
x = 1
for i in range(255):
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if x & 0x100:
        x ^= 0x11d
for i in range(255, 512):
    EXP[i] = EXP[i - 255]


def gmul(a, b):
    if a == 0 or b == 0:
        return 0
    return EXP[LOG[a] + LOG[b]]


def rs_syndrome(codeword, ec_len):
    """计算 syndrome；全零表示无错误"""
    syn = []
    for i in range(ec_len):
        s = 0
        for c in codeword:
            s = gmul(s, EXP[i]) ^ c
        syn.append(s)
    return syn


VERSION_M = {
    1:  [10, 1, 16, 0, 0],   2:  [16, 1, 28, 0, 0],   3:  [26, 1, 44, 0, 0],
    4:  [18, 2, 32, 0, 0],   5:  [24, 2, 43, 0, 0],   6:  [16, 4, 27, 0, 0],
    7:  [18, 4, 31, 0, 0],   8:  [22, 2, 38, 2, 39],  9:  [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44],
}

MASKS = [
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: ((r * c) % 2) + ((r * c) % 3) == 0,
    lambda r, c: (((r * c) % 2) + ((r * c) % 3)) % 2 == 0,
    lambda r, c: (((r + c) % 2) + ((r * c) % 3)) % 2 == 0,
]

ALIGN_POS = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}


def build_function_map(size, version):
    fn = [[False] * size for _ in range(size)]

    def mark_finder(r0, c0):
        for r in range(-1, 8):
            for c in range(-1, 8):
                rr, cc = r0 + r, c0 + c
                if 0 <= rr < size and 0 <= cc < size:
                    fn[rr][cc] = True

    mark_finder(0, 0)
    mark_finder(0, size - 7)
    mark_finder(size - 7, 0)

    for i in range(size):
        fn[6][i] = True
        fn[i][6] = True

    for r0 in ALIGN_POS[version]:
        for c0 in ALIGN_POS[version]:
            if (r0 <= 8 and c0 <= 8) or (r0 <= 8 and c0 >= size - 9) or (r0 >= size - 9 and c0 <= 8):
                continue
            for r in range(-2, 3):
                for c in range(-2, 3):
                    fn[r0 + r][c0 + c] = True

    for i in range(9):
        fn[8][i] = True
        fn[i][8] = True
    for i in range(8):
        fn[8][size - 1 - i] = True
        fn[size - 1 - i][8] = True

    if version >= 7:
        for i in range(6):
            for j in range(3):
                fn[size - 11 + j][i] = True
                fn[i][size - 11 + j] = True

    return fn


def read_format(m, size):
    """按标准位序读格式信息，返回 (ec_level, mask)"""
    bits = []
    # 第一份：左上，按 k=0..14 的顺序
    bits.append(m[8][0]); bits.append(m[8][1]); bits.append(m[8][2])
    bits.append(m[8][3]); bits.append(m[8][4]); bits.append(m[8][5])
    bits.append(m[8][7]); bits.append(m[8][8]); bits.append(m[7][8])
    bits.append(m[5][8]); bits.append(m[4][8]); bits.append(m[3][8])
    bits.append(m[2][8]); bits.append(m[1][8]); bits.append(m[0][8])

    val = 0
    for b in bits:
        val = (val << 1) | b
    val ^= 0x5412

    ec_level = (val >> 13) & 0b11
    mask = (val >> 10) & 0b111
    return ec_level, mask


def extract_codewords(m, size, version, mask_idx):
    fn = build_function_map(size, version)
    mask = MASKS[mask_idx]
    bits = []

    upward = True
    col = size - 1
    while col > 0:
        if col == 6:
            col = 5
        for i in range(size):
            row = size - 1 - i if upward else i
            for c in (col, col - 1):
                if fn[row][c]:
                    continue
                bit = m[row][c]
                if mask(row, c):
                    bit ^= 1
                bits.append(bit)
        upward = not upward
        col -= 2

    words = []
    for i in range(0, len(bits) - 7, 8):
        b = 0
        for j in range(8):
            b = (b << 1) | bits[i + j]
        words.append(b)
    return words


def deinterleave(words, version):
    ec_len, b1, d1, b2, d2 = VERSION_M[version]
    blocks = []
    for i in range(b1):
        blocks.append({'d': [], 'e': [], 'cap': d1})
    for i in range(b2):
        blocks.append({'d': [], 'e': [], 'cap': d2})

    idx = 0
    max_d = max(d1, d2)
    for i in range(max_d):
        for blk in blocks:
            if i < blk['cap'] and idx < len(words):
                blk['d'].append(words[idx]); idx += 1
    for i in range(ec_len):
        for blk in blocks:
            if idx < len(words):
                blk['e'].append(words[idx]); idx += 1
    return blocks


def decode_bits(blocks, version):
    stream = []
    for blk in blocks:
        for b in blk['d']:
            for i in range(7, -1, -1):
                stream.append((b >> i) & 1)

    pos = 0

    def take(n):
        nonlocal pos
        v = 0
        for _ in range(n):
            v = (v << 1) | stream[pos]
            pos += 1
        return v

    mode = take(4)
    if mode != 0b0100:
        raise ValueError("非 Byte 模式，mode=%04b" % mode)
    length = take(8 if version <= 9 else 16)
    data = bytearray()
    for _ in range(length):
        data.append(take(8))
    return data.decode('utf-8', errors='replace')


def verify_one(modules, expect_text):
    size = len(modules)
    version = (size - 17) // 4
    if version not in VERSION_M:
        return False, "不支持的版本 %d" % version

    ec_level, mask = read_format(modules, size)
    words = extract_codewords(modules, size, version, mask)
    blocks = deinterleave(words, version)

    ec_len = VERSION_M[version][0]
    rs_ok = True
    for i, blk in enumerate(blocks):
        cw = blk['d'] + blk['e']
        if any(rs_syndrome(cw, ec_len)):
            rs_ok = False

    try:
        text = decode_bits(blocks, version)
    except Exception as e:
        return False, "解码失败: %s (RS=%s, mask=%d)" % (e, rs_ok, mask)

    if not rs_ok:
        return False, "RS 纠错校验失败 (mask=%d)" % mask
    if text != expect_text:
        return False, "内容不符: 解出 %r，期望 %r" % (text, expect_text)
    return True, "v%d %dx%d mask=%d RS通过" % (version, size, size, mask)


if __name__ == '__main__':
    inp, outp = sys.argv[1], sys.argv[2]
    payload = json.load(open(inp, encoding='utf-8'))
    results = []
    for c in payload['cases']:
        try:
            ok, detail = verify_one(c['modules'], c['text'])
        except Exception as e:
            ok, detail = False, "异常: %s" % e
        results.append({'text': c['text'], 'ok': ok, 'detail': detail})
    with open(outp, 'w', encoding='utf-8') as f:
        json.dump({'results': results}, f, ensure_ascii=False, indent=2)
    print("已写入", outp)
