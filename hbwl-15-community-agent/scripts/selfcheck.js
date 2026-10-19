'use strict';

/**
 * 自检脚本 —— 验证知识库与检索引擎工作正常
 *   node scripts/selfcheck.js
 *
 * 覆盖：事实类问答、意图路由、紧急识别、兜底行为、数据溯源完整性
 */

const path = require('path');
const fs = require('fs');
const { CommunityAgent, INTENTS } = require(path.join(__dirname, '..', 'lib', 'agent'));

const agent = new CommunityAgent();

// ---------- 事实类问答 ----------
// 期望值取自官方公开信息，改数据时若这些断言失败，说明真实信息被改动
const CASES = [
  { q: '宿舍东西坏了怎么报修？',        expect: /微后勤|报修/ },
  { q: '学校的报警电话是多少？',        expect: /3593110/ },
  { q: '遇到电信诈骗怎么办？',          expect: /110|96110|报警/ },
  { q: '心理压力大想找人聊聊，可以找谁？', expect: /3591827|2453222047|12356/ },
  { q: '心理健康教育中心怎么预约？',     expect: /3591827|2453222047/ },
  { q: '学生证丢了怎么补办？',          expect: /补办|本科生院|3590744/ },
  { q: '计算机工程学院有哪些专业？',     expect: /人工智能|软件工程|物联网/ },
  { q: '计算机工程学院的电话是多少？',    expect: /3593152/ },
  { q: '学校地址在哪？',               expect: /隆中路296号|襄阳/ },
  { q: '宿舍安全用电要注意什么？',       expect: /违规电器|大功率|私拉乱接/ },
  { q: '家庭经济困难认定怎么申请？',     expect: /认定|资助|助学金/ },
  { q: '想换宿舍怎么办？',             expect: /调宿|申请|14栋|住宿/ },
  { q: '食堂相关问题找谁？',            expect: /后勤|3590633|伙食/ },
  { q: '热水、开水、洗衣机坏了找谁修？',  expect: /资产公司|18372264416|开水/ },
  { q: '学校有哪些常用网站和线上服务入口？', expect: /ehall|信息门户|home\.hbuas/ },
  { q: '这个智能体能做什么？',          expect: /通知|活动|智能体/ },
  { q: '15栋一站式社区服务中心在哪里？',  expect: /15栋|待确认|在建|建设中|正式通知/ },

  // —— 图书馆（来源 s013）——
  { q: '图书馆开放时间',               expect: /8:00|21:00|22:00|6:30/ },
  { q: '图书馆电话是多少',             expect: /3590731/ },
  { q: '图书馆有哪些数据库？',          expect: /知网|CNKI|万方|读秀/ },
  { q: '图书馆怎么借书？',             expect: /校园卡|借还|借阅/ },

  // —— 教务与考试（来源 s009）——
  { q: '四六级报名时间',               expect: /本科生院|通知|CET|报名/ },
  { q: '怎么选课？',                  expect: /教务|本科生院|信息门户|选课/ },
  { q: '转专业需要什么条件？',          expect: /转专业|本科生院|申请/ },
  { q: '学校校历在哪看？',             expect: /校历|本科生院|放假|官网/ },

  // —— 资助（来源 s004 / s012）——
  { q: '怎么申请助学贷款？',            expect: /生源地|贷款|资助/ },
  { q: '奖学金怎么申请？',             expect: /奖学金|评定|国家/ },

  // —— 生活服务 ——
  { q: '校园卡怎么办理？',             expect: /一卡通|校园卡|补办|挂失/ },
  { q: '宿舍几点熄灯？',               expect: /熄灯|作息|门禁|规定/ },
  { q: '体育场馆怎么预约？',            expect: /体育|场馆|操场|预约/ },
  { q: '学校有几个校区？',             expect: /隆中|卧龙|东津|校区/ },
  { q: '校园内电动车怎么充电？',         expect: /电动车|充电|严禁|停放/ },
];

let pass = 0;
let fail = 0;
const failures = [];

const line = '='.repeat(64);
console.log(line);
console.log('  15栋社区智能体 · 自检');
console.log(line);
console.log('  事实类问答');
console.log('-'.repeat(64));

for (const c of CASES) {
  const r = agent.ask(c.q);
  const ok = c.expect.test(r.text);
  if (ok) { pass++; console.log(`  ✓ ${c.q}`); }
  else {
    fail++;
    failures.push({ q: c.q, got: r.text.slice(0, 160), intent: r.intent });
    console.log(`  ✗ ${c.q}   [intent=${r.intent}]`);
  }
}

// ---------- 兜底与边界 ----------
console.log('-'.repeat(64));
console.log('  边界处理');
console.log('-'.repeat(64));

const offTopic = agent.ask('今天天气怎么样');
const fallbackOk = offTopic.intent === 'fallback';
console.log(`  ${fallbackOk ? '✓' : '✗'} 无关问题走兜底  [intent=${offTopic.intent}]`);
if (fallbackOk) pass++; else { fail++; failures.push({ q: '今天天气怎么样', got: offTopic.text.slice(0, 120), intent: offTopic.intent }); }

const empty = agent.ask('');
const emptyOk = empty.intent === 'empty';
console.log(`  ${emptyOk ? '✓' : '✗'} 空输入处理  [intent=${empty.intent}]`);
if (emptyOk) pass++; else fail++;

// ---------- 意图路由 ----------
// 两组最易回归的场景：
//  1) 列表类问题被 FAQ 流程条目劫持
//  2) 紧急事实被当成普通咨询
console.log('-'.repeat(64));
console.log('  意图路由');
console.log('-'.repeat(64));

const ROUTING = [
  { q: '最近有什么活动可以报名？', want: 'activities' },
  { q: '最近有什么通知？',         want: 'notices' },
  { q: '社区有哪些活动？',         want: 'activities' },
  { q: '我已经被诈骗了怎么办',     want: 'emergency' },
  { q: '刚刚给骗子转账了',         want: 'emergency' },
  { q: '宿舍着火了',               want: 'emergency' },
  { q: '同学受伤了需要急救',       want: 'emergency' },
  { q: '有人威胁我',               want: 'emergency' },
  { q: '救命',                     want: 'emergency' },
  { q: '遇到电信诈骗怎么办',       wantNot: 'emergency' },
  { q: '常见的诈骗手法有哪些',     wantNot: 'emergency' },
  // 查电话 ≠ 紧急事件：问「报警电话」只是要号码，不该给处置流程
  { q: '学校的报警电话是多少？',   wantNot: 'emergency' },
  { q: '保卫处电话',               wantNot: 'emergency' },
  { q: '心理中心电话是多少',       wantNot: 'emergency' },
];

for (const c of ROUTING) {
  const r = agent.ask(c.q);
  const ok = c.want ? r.intent === c.want : r.intent !== c.wantNot;
  if (ok) { pass++; console.log(`  ✓ ${c.q}  [${r.intent}]`); }
  else {
    fail++;
    const expect = c.want ? `期望 ${c.want}` : `期望非 ${c.wantNot}`;
    console.log(`  ✗ ${c.q}  实际 ${r.intent}，${expect}`);
    failures.push({ q: c.q, got: r.text.slice(0, 100), intent: r.intent });
  }
}

// ---------- 数据溯源完整性 ----------
// 关键：标 verified:true 的条目必须能追溯到来源，否则「已核实」是空话
console.log('-'.repeat(64));
console.log('  数据溯源');
console.log('-'.repeat(64));

const DATA = path.join(__dirname, '..', 'data');
const readJSON = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n), 'utf8'));

let traceFail = 0;
const collections = {
  'notices.json': readJSON('notices.json'),
  'faq.json': readJSON('faq.json'),
  'activities.json': readJSON('activities.json'),
  'venues.json': readJSON('venues.json'),
};

const sourceIds = new Set(
  (readJSON('sources.json').sources || []).map((s) => s.id)
);

let verifiedCount = 0;
let unverifiedCount = 0;

for (const [file, items] of Object.entries(collections)) {
  for (const item of items) {
    if (item.verified === true) {
      verifiedCount++;
      // 已核实条目必须有 sourceId，且该 sourceId 必须存在于 sources.json
      if (!item.sourceId || !sourceIds.has(item.sourceId)) {
        traceFail++;
        console.log(`  ✗ ${file} · ${item.id} 标为已核实但缺少有效来源`);
      }
    } else if (item.verified === false) {
      unverifiedCount++;
    } else {
      traceFail++;
      console.log(`  ✗ ${file} · ${item.id} 缺少 verified 字段`);
    }
  }
}

if (traceFail === 0) {
  pass++;
  console.log(`  ✓ 溯源完整：已核实 ${verifiedCount} 条 · 待确认 ${unverifiedCount} 条`);
  console.log(`  ✓ 全部已核实条目均可追溯到官方来源（共 ${sourceIds.size} 个来源）`);
} else {
  fail++;
  console.log(`  ✗ 溯源检查失败：${traceFail} 处问题`);
}

// ---------- 汇总 ----------
console.log(line);
console.log(`  通过 ${pass} / ${pass + fail}`);
console.log(line);

if (failures.length) {
  console.log('\n失败详情：');
  for (const f of failures) {
    console.log(`\n  问题: ${f.q}`);
    console.log(`  意图: ${f.intent}`);
    console.log(`  回答: ${f.got.replace(/\n/g, ' / ')}`);
  }
}

const stats = agent.stats();
console.log(`\n知识库：通知 ${stats.notices} · FAQ ${stats.faqs} · 活动 ${stats.activities} · 场所 ${stats.venues}`);
console.log(`       共 ${stats.total} 条，已核实 ${stats.verified} 条，待确认 ${stats.unverified} 条`);
console.log(`来源：${stats.sourceCount} 个官方渠道　数据更新：${stats.updatedAt}`);
console.log(`问答模式：离线检索（本地知识库，不调用大模型）`);

process.exit(fail === 0 ? 0 : 1);
