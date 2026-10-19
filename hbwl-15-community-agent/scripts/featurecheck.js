'use strict';

/**
 * 新增功能回归测试
 *
 *   node scripts/featurecheck.js
 *
 * 前置条件：服务需正在运行（node server.js）
 * 环境变量：PORT（默认 8080）、TEACHER_PIN（默认取 data/_config.json）
 *
 * 覆盖本轮补齐的功能，每一项都对应过真实缺陷：
 *
 *   1. 活动过期自动标记
 *      —— 原先活动状态是教师手填的静态字段，过了截止日期仍显示「报名中」，
 *         同学会白跑一趟。现在按日期计算实际状态。
 *
 *   2. 教师端发布活动
 *      —— 原先校验把活动当通知处理，强制要求 content 字段，
 *         而活动用的是 summary/detail，导致**教师端无法发布任何活动**。
 *
 *   3. 学生反馈接口
 *      —— 新增「有用/没用」反馈，看板可统计满意度与被点「没用」的问题。
 *
 *   4. 电话号码可拨号
 *      —— 侧栏与回答中的电话带 tel: 链接，手机上点击直接拨号。
 *
 *   5. 日志轮转配置
 *      —— 日志保留天数已配置，避免无限增长。
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

(async () => {
  const line = '='.repeat(60);
  console.log(line);
  console.log('  新增功能回归测试');
  console.log(line);

  // 前置：服务在跑吗
  const health = await req('GET', '/api/health');
  if (health.code !== 200) {
    console.log(`\n  ✗ 服务未运行（端口 ${PORT}）。请先执行 node server.js\n`);
    process.exit(1);
  }

  // 登录
  const login = await req('POST', '/api/teacher/login', { pin: loadPin() });
  if (login.code !== 200) {
    console.log('\n  ✗ 教师端登录失败：' + JSON.stringify(login.body));
    console.log('    （可用 TEACHER_PIN 环境变量指定口令）\n');
    process.exit(1);
  }
  const token = login.body.token;

  let cleanupId = null;

  try {
    // ---- 1. 活动过期标记 ----
    console.log('\n【1】活动过期自动标记');
    let r = await req('GET', '/api/activities');
    const acts = Array.isArray(r.body) ? r.body : [];
    check('活动接口返回正常', r.code === 200 && acts.length > 0);

    // 插入一条已过期活动
    r = await req('POST', '/api/teacher/content/activities', {
      title: '【验证】已过期活动',
      category: '测试',
      date: '2026-10-01',
      time: '9:00',
      location: '测试',
      organizer: '测试',
      status: '报名中',
      deadline: '2026-10-05',
      tags: ['验证'],
      summary: '验证用',
      detail: '验证用',
      verified: false,
    }, token);
    // 这条同时验证了「教师端能否发布活动」（原先因校验缺陷必然失败）
    check('教师端可发布活动', r.code === 200, r.code !== 200 ? JSON.stringify(r.body) : '');
    cleanupId = r.body && r.body.item && r.body.item.id;

    // 学生端查活动列表，过期活动不应出现在「可报名」区
    r = await req('POST', '/api/ask', { question: '最近有什么活动可以报名' });
    const text = String(r.body.text || '');
    check('过期活动未显示为可报名',
      !text.includes('【验证】已过期活动') || text.includes('已结束') || text.includes('已截止'),
      '仍显示为可报名');

    // ---- 2. 学生反馈接口 ----
    console.log('\n【2】学生反馈接口');
    r = await req('POST', '/api/feedback', {
      question: '测试反馈问题', helpful: false, intent: 'retrieval', answerHead: '测试回答',
    });
    check('反馈接口可用', r.code === 200);

    r = await req('POST', '/api/feedback', {
      question: '测试反馈问题', helpful: true, intent: 'retrieval', answerHead: '测试回答',
    });
    check('有用反馈也能记录', r.code === 200);

    r = await req('GET', '/api/teacher/dashboard?days=7', null, token);
    const fb = r.body.feedback;
    check('看板返回 feedback 字段', !!fb);
    check('反馈总数已统计', fb && fb.total >= 2, `total=${fb && fb.total}`);
    check('满意度已计算', fb && fb.satisfaction !== null, `satisfaction=${fb && fb.satisfaction}`);
    check('被点「没用」的问题已列出', fb && fb.topUnhelpful.length > 0);

    // ---- 3. 电话拨号链接 ----
    console.log('\n【3】电话号码可拨号');
    r = await req('GET', '/student');
    const html = r.raw || '';
    check('侧栏含 tel: 链接', html.includes('tel:07103593110'));
    check('紧急电话含 110 拨号', html.includes('tel:110'));

    r = await req('POST', '/api/ask', { question: '学校的报警电话是多少？' });
    check('问答接口正常返回', r.code === 200);

    // ---- 4. 日志轮转 ----
    console.log('\n【4】日志轮转配置');
    const content = require('../lib/content');
    check('LOG_RETAIN_DAYS 已导出', typeof content.LOG_RETAIN_DAYS === 'number',
      `值=${content.LOG_RETAIN_DAYS}`);

  } catch (e) {
    fail++;
    console.log(`\n  ✗ 测试中断：${e.message}`);
  } finally {
    // ---- 清理 ----
    if (cleanupId) {
      const r = await req('DELETE', `/api/teacher/content/activities/${cleanupId}`, null, token);
      console.log(`\n【清理】测试活动：${r.code === 200 ? '✓ 已删除' : '✗ 请手动检查 ' + cleanupId}`);
    }
  }

  console.log('\n' + line);
  console.log(`  通过 ${pass} / ${pass + fail}`);
  console.log(line);
  if (fail === 0) console.log('\n  全部通过。\n');
  else console.log('\n  存在失败项，请检查对应功能。\n');

  process.exit(fail === 0 ? 0 : 1);
})();
