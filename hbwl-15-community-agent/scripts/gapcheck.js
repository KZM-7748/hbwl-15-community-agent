'use strict';

/**
 * 「待补充问题 → 补充答案 → 立即可查」闭环测试
 *
 *   node scripts/gapcheck.js
 *
 * 前置条件：服务需正在运行（node server.js）
 *
 * 测什么：这是教师端最有价值的工作流 —— 发现缺口、补齐、立即生效。
 *
 *   1. 同学问一个知识库没有的问题
 *      → 应被标记为「缺口」（未命中 或 低置信度）
 *   2. 教师端看板的「待补充清单」应包含该问题
 *   3. 点「补充答案」保存 FAQ 后，同一个问题应立即能答上
 *   4. 换一种问法也应能命中（验证关键词起作用）
 *   5. 删除该 FAQ 后，应重新回到缺口状态
 *
 * 关于「缺口」的两种形态（都在待补充清单里）：
 *   · 未命中（fallback）—— 智能体完全答不上来
 *   · 低置信度（lowConfidence）—— 答了，但可能答非所问
 *     实测例子：「校车几点发车」被答成「宿舍几点熄灯」，得分 7.86。
 *     系统认为答上了，但实际没解决 —— 这类更隐蔽，也必须进待补充清单。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);

function loadPin() {
  if (process.env.TEACHER_PIN) return process.env.TEACHER_PIN;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', '_config.json'), 'utf8'));
    return cfg.teacherPin;
  } catch {
    return 'hbuas2026';
  }
}

function req(method, p, body, token) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (resp) => {
      let d = '';
      resp.on('data', (c) => d += c);
      resp.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch { j = d; }
        res({ code: resp.statusCode, body: j, raw: d });
      });
    });
    r.on('error', (e) => res({ code: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

// 知识库里没有的问题（实测得分 7.86，属低置信度）
const GAP_Q = '校车几点发车';
// 换一种问法，验证关键词是否起作用
const GAP_Q2 = '校车发车时间';

(async () => {
  const line = '='.repeat(62);
  console.log(line);
  console.log('  待补充问题 → 补充答案 → 立即可查');
  console.log(line);

  // 前置：服务在跑吗
  const health = await req('GET', '/api/health');
  if (health.code !== 200) {
    console.log(`\n  ✗ 服务未运行（端口 ${PORT}）。请先执行 node server.js\n`);
    process.exit(1);
  }

  const login = await req('POST', '/api/teacher/login', { pin: loadPin() });
  if (login.code !== 200) {
    console.log('\n  ✗ 教师端登录失败：' + JSON.stringify(login.body));
    console.log('    （可用 TEACHER_PIN 环境变量指定口令）\n');
    process.exit(1);
  }
  const token = login.body.token;

  let faqId = null;

  try {
    // ---- 1. 提问一个知识库没有的问题 ----
    console.log('\n【1】提问一个知识库没有的问题');
    let r = await req('POST', '/api/ask', { question: GAP_Q });
    const isGap = r.body.intent === 'fallback' || r.body.lowConfidence === true;
    check('被标记为缺口（未命中或低置信度）', isGap,
      `intent=${r.body.intent}, lowConfidence=${r.body.lowConfidence}`);
    console.log(`     意图: ${r.body.intent}  低置信度: ${!!r.body.lowConfidence}`);

    // ---- 2. 看板的待补充清单应包含它 ----
    console.log('\n【2】教师端看板「待补充清单」');
    r = await req('GET', '/api/teacher/dashboard?days=7', null, token);
    const gaps = r.body.pendingAnswers || [];
    const found = gaps.find((x) => x.q === GAP_Q);
    check('清单包含该问题', !!found, `未找到「${GAP_Q}」`);
    if (found) {
      console.log(`     标记：未命中 ${found.missed} 次 / 可能答错 ${found.low} 次 / 被点没用 ${found.unhelpful} 次`);
    }

    // ---- 3. 补充答案 ----
    console.log('\n【3】补充答案并保存为 FAQ');
    r = await req('POST', '/api/teacher/content/faqs', {
      question: GAP_Q,
      category: '生活',
      answer: '校车运行安排请见后勤保障处通知，通勤车及公交专线时刻表以官方发布为准。\n\n📞 后勤保障处：0710-3590633',
      keywords: ['校车', '发车', '时刻表', '通勤车', '公交专线', '校车时间'],
      verified: false,
    }, token);
    check('FAQ 创建成功', r.code === 200, r.code !== 200 ? JSON.stringify(r.body) : '');
    faqId = r.body && r.body.item && r.body.item.id;

    // ---- 4. 核心：同一个问题现在能答上 ----
    console.log('\n【4】同一个问题现在能答上了吗（核心）');
    r = await req('POST', '/api/ask', { question: GAP_Q });
    check('不再被标记为缺口', r.body.intent !== 'fallback' && !r.body.lowConfidence,
      `intent=${r.body.intent}, lowConfidence=${r.body.lowConfidence}`);
    check('回答包含刚补充的内容', String(r.body.text).includes('后勤保障处'));
    console.log(`     首行: ${String(r.body.text).split('\n')[0].slice(0, 46)}`);

    // ---- 5. 换一种问法也能命中 ----
    console.log('\n【5】换一种问法也能命中');
    r = await req('POST', '/api/ask', { question: GAP_Q2 });
    check('同义问法也能答上', String(r.body.text).includes('后勤保障处'),
      `intent=${r.body.intent}`);

    // ---- 6. 删除后应重新变为缺口 ----
    console.log('\n【6】删除后回到缺口状态');
    r = await req('DELETE', `/api/teacher/content/faqs/${faqId}`, null, token);
    check('删除测试 FAQ', r.code === 200);
    faqId = null;

    r = await req('POST', '/api/ask', { question: GAP_Q });
    const gapAgain = r.body.intent === 'fallback' || r.body.lowConfidence === true;
    check('重新被标记为缺口', gapAgain,
      `intent=${r.body.intent}, lowConfidence=${r.body.lowConfidence}`);

  } catch (e) {
    fail++;
    console.log(`\n  ✗ 测试中断：${e.message}`);
  } finally {
    if (faqId) {
      const r = await req('DELETE', `/api/teacher/content/faqs/${faqId}`, null, token);
      console.log(`\n【清理】测试 FAQ：${r.code === 200 ? '✓ 已删除' : '✗ 请手动检查 ' + faqId}`);
    }
  }

  console.log('\n' + line);
  console.log(`  通过 ${pass} / ${pass + fail}`);
  console.log(line);
  if (fail === 0) {
    console.log('\n  缺口发现 → 补充答案 → 立即生效，闭环正常。\n');
  } else {
    console.log('\n  存在失败项，请检查对应环节。\n');
  }
  process.exit(fail === 0 ? 0 : 1);
})();
