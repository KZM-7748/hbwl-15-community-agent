'use strict';

/**
 * 容量基准测试 —— 用数据回答「需不需要数据库」
 *
 *   node scripts/benchmark.js
 *
 * 测什么：
 *   1. 知识库读写延迟（当前实现是「整文件读 + 整文件原子写」）
 *   2. 问答日志的写入与看板聚合延迟，随日志量增长的变化
 *   3. 找出实际的性能拐点，据此判断何时需要换存储方案
 *
 * 说明：本脚本在临时目录生成测试数据，不触碰 data/ 下的真实文件。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// ---------- 工具 ----------

function timeit(label, fn, iterations = 1) {
  // 预热
  try { fn(); } catch { /* ignore */ }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / iterations;
  return { label, ms, iterations };
}

function fmt(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const results = [];
function record(r) { results.push(r); }

// ---------- 1. 知识库规模增长模拟 ----------

console.log('='.repeat(68));
console.log('  容量基准测试：判断是否需要数据库');
console.log('='.repeat(68));

console.log('\n【1】知识库读写延迟 vs 条数');
console.log('     （当前实现：整文件 JSON 读 + 临时文件原子写）');
console.log('');
console.log('     ' + '条数'.padEnd(10) + '文件大小'.padEnd(14) + '读'.padEnd(14) + '写'.padEnd(14) + '解析+序列化');
console.log('     ' + '-'.repeat(62));

const SAMPLE = {
  id: 'f001',
  category: '测试',
  question: '这是一条用于基准测试的问题，长度接近真实条目',
  keywords: ['测试', '基准', '性能'],
  answer: '这是一段用于基准测试的回答文本。'.repeat(12),
  verified: true,
  sourceId: 's001',
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));

for (const n of [100, 500, 1000, 5000, 20000]) {
  const items = Array.from({ length: n }, (_, i) => ({ ...SAMPLE, id: 'f' + String(i).padStart(5, '0') }));
  const file = path.join(tmpDir, `test-${n}.json`);
  const json = JSON.stringify(items, null, 2);
  fs.writeFileSync(file, json, 'utf8');
  const sizeKB = Buffer.byteLength(json) / 1024;

  const readR = timeit('read', () => { fs.readFileSync(file, 'utf8'); }, 20);
  const parseR = timeit('parse', () => { JSON.parse(fs.readFileSync(file, 'utf8')); }, 20);
  const writeR = timeit('write', () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file);
  }, 20);

  console.log('     ' +
    String(n).padEnd(10) +
    `${sizeKB.toFixed(0)} KB`.padEnd(14) +
    fmt(readR.ms).padEnd(14) +
    fmt(writeR.ms).padEnd(14) +
    fmt(parseR.ms));

  if (n === 1000) record({ what: '知识库 1000 条：读+解析', ms: parseR.ms });
  if (n === 5000) record({ what: '知识库 5000 条：读+解析', ms: parseR.ms });
}

// ---------- 2. 问答日志增长 ----------

console.log('\n【2】问答日志：写入延迟与看板聚合延迟');
console.log('     （当前实现：JSONL 追加写 + 看板时全量读取聚合）');
console.log('');
console.log('     ' + '日志条数'.padEnd(12) + '文件大小'.padEnd(13) + '追加写'.padEnd(13) + '读取+聚合'.padEnd(14) + '聚合本身');
console.log('     ' + '-'.repeat(66));

const LOG_SAMPLE = JSON.stringify({
  t: Date.now(), q: '宿舍东西坏了怎么报修？', intent: 'retrieval', verified: true,
});

for (const n of [1000, 10000, 100000, 500000]) {
  const logFile = path.join(tmpDir, `log-${n}.jsonl`);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(LOG_SAMPLE);
  fs.writeFileSync(logFile, lines.join('\n') + '\n', 'utf8');
  const sizeMB = fs.statSync(logFile).size / 1024 / 1024;

  const appendR = timeit('append', () => {
    fs.appendFileSync(logFile, LOG_SAMPLE + '\n', 'utf8');
  }, 20);

  // 模拟 dashboard 的聚合逻辑
  const aggregate = (records) => {
    const freq = new Map();
    const missed = new Map();
    const intents = new Map();
    for (const r of records) {
      const key = String(r.q || '').trim();
      if (key) freq.set(key, (freq.get(key) || 0) + 1);
      if (r.intent === 'fallback' && key) missed.set(key, (missed.get(key) || 0) + 1);
      intents.set(r.intent, (intents.get(r.intent) || 0) + 1);
    }
    return {
      top: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      missed: [...missed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      intents: [...intents.entries()],
    };
  };

  const fullR = timeit('full', () => {
    const raw = fs.readFileSync(logFile, 'utf8');
    const recs = [];
    for (const ln of raw.split('\n')) {
      if (!ln.trim()) continue;
      try { recs.push(JSON.parse(ln)); } catch { /* skip */ }
    }
    aggregate(recs);
  }, 3);

  // 只测聚合（不含 IO）
  const rawOnce = fs.readFileSync(logFile, 'utf8');
  const recsOnce = rawOnce.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const aggR = timeit('agg', () => aggregate(recsOnce), 5);

  console.log('     ' +
    String(n).padEnd(12) +
    `${sizeMB.toFixed(1)} MB`.padEnd(13) +
    fmt(appendR.ms).padEnd(13) +
    fmt(fullR.ms).padEnd(14) +
    fmt(aggR.ms));

  record({ what: `日志 ${n} 条：看板聚合`, ms: fullR.ms });
}

// ---------- 3. 并发问答吞吐 ----------

console.log('\n【3】问答吞吐（含日志写入）');
console.log('');

const { CommunityAgent } = require('../lib/agent');
const agent = new CommunityAgent();
const QUESTIONS = [
  '宿舍东西坏了怎么报修？', '学校的报警电话是多少？', '图书馆开放时间',
  '学生证丢了怎么补办？', '心理压力大想找人聊聊', '四六级报名时间',
];

const qps = timeit('qps', () => {
  for (const q of QUESTIONS) agent.ask(q);
}, 50);
const perQuery = qps.ms / QUESTIONS.length;
console.log(`     单次问答（检索+生成）: ${fmt(perQuery)}`);
console.log(`     估算吞吐: ${Math.round(1000 / perQuery)} 次/秒（单进程）`);

// ---------- 结论 ----------

console.log('\n' + '='.repeat(68));
console.log('  实测结论');
console.log('='.repeat(68));

const kb1000 = results.find((r) => r.what.includes('1000'));
const kb5000 = results.find((r) => r.what.includes('5000'));
const log10k = results.find((r) => r.what.includes('10000'));
const log100k = results.find((r) => r.what.includes('100000'));
const log500k = results.find((r) => r.what.includes('500000'));

console.log('');
console.log(`  知识库 1000 条时，一次读取+解析约 ${fmt(kb1000.ms)}`);
console.log(`  知识库 5000 条时，一次读取+解析约 ${fmt(kb5000.ms)}`);
console.log('');
console.log(`  日志 1 万条时，看板聚合约 ${fmt(log10k.ms)}`);
console.log(`  日志 10 万条时，看板聚合约 ${fmt(log100k.ms)}`);
console.log(`  日志 50 万条时，看板聚合约 ${fmt(log500k.ms)}`);
console.log('');
console.log(`  单次问答耗时约 ${fmt(perQuery)}，单进程吞吐约 ${Math.round(1000 / perQuery)} 次/秒`);

// 清理
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('');
console.log('  （测试数据在临时目录，已清理；未触碰 data/ 下真实文件）');
console.log('='.repeat(68));
