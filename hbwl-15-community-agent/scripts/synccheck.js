'use strict';

/**
 * 数据同步回归测试
 *
 *   node scripts/synccheck.js
 *
 * 为什么需要这个测试：
 *   问答用的是**内存中的**知识库（this.notices / this.index），
 *   而教师端改的是**磁盘上的** JSON 文件。
 *   如果写入后不重建内存索引，就会出现「老师发布了通知，同学却查不到，
 *   必须重启服务才生效」——教师端形同虚设。
 *
 *   这个缺陷在开发期真实出现过（见 README 技术方案章节），因此固化为回归测试。
 *
 * 测试内容：
 *   1. 教师端发布一条带独特关键词的通知
 *   2. 立即通过学生端问答接口查询该关键词 → 必须能查到
 *   3. 公开通知列表接口 → 必须包含该条
 *   4. 修改后再查 → 必须看到新内容
 *   5. 删除后再查 → 必须查不到
 *   6. 清理测试数据（无论成功失败都执行）
 *
 * 前置条件：服务需正在运行（node server.js）
 * 环境变量：PORT（默认 8080）、TEACHER_PIN（默认取 data/_config.json）
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
        res({ code: resp.statusCode, body: j });
      });
    });
    r.on('error', (e) => res({ code: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

// 独特关键词：确保不会误命中已有知识库内容
const MARKER = '量子计算实验室开放预约';
const MARKER2 = '量子计算实验室暂停使用';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++;
    failures.push(name + (detail ? `（${detail}）` : ''));
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

(async () => {
  const line = '='.repeat(62);
  console.log(line);
  console.log('  数据同步回归测试（教师端改动 → 学生端即时可见）');
  console.log(line);

  // 前置：服务在跑吗
  const health = await req('GET', '/api/health');
  if (health.code !== 200) {
    console.log(`\n  ✗ 服务未运行（端口 ${PORT}）。请先执行 node server.js\n`);
    process.exit(1);
  }
  const revBefore = health.body.knowledgeRevision;
  console.log(`\n  服务正常，当前知识库版本号：${revBefore}\n`);

  // 登录
  const login = await req('POST', '/api/teacher/login', { pin: loadPin() });
  if (login.code !== 200) {
    console.log('  ✗ 教师端登录失败：' + JSON.stringify(login.body));
    console.log('    （可用 TEACHER_PIN 环境变量指定口令）\n');
    process.exit(1);
  }
  const token = login.body.token;

  let newId = null;

  try {
    // ---- 1. 发布 ----
    console.log('  1. 教师端发布通知');
    let r = await req('POST', '/api/teacher/content/notices', {
      title: MARKER,
      category: '自动测试',
      publisher: '同步测试',
      date: '2026-10-16',
      content: '用于验证数据同步的测试通知。关键词：' + MARKER,
      tags: [MARKER, '量子计算', '实验室'],
      verified: false,
    }, token);
    check('发布成功', r.code === 200, r.code !== 200 ? JSON.stringify(r.body) : '');
    if (r.code !== 200) throw new Error('发布失败，后续测试无法进行');
    newId = r.body.item.id;

    // 版本号应递增
    const h1 = await req('GET', '/api/health');
    check('知识库版本号已递增', h1.body.knowledgeRevision > revBefore,
      `before=${revBefore} after=${h1.body.knowledgeRevision}`);

    // ---- 2. 学生端问答能查到 ----
    console.log('\n  2. 学生端问答查询（核心检查）');
    r = await req('POST', '/api/ask', { question: MARKER });
    check('问答能查到新发布的内容', String(r.body.text || '').includes(MARKER),
      '问答未返回该内容 → 内存索引未重建');

    // ---- 3. 公开列表包含 ----
    console.log('\n  3. 公开接口列表');
    r = await req('GET', '/api/notices');
    check('/api/notices 包含新通知',
      Array.isArray(r.body) && r.body.some((x) => x.id === newId));

    // ---- 4. 修改后可见新内容 ----
    console.log('\n  4. 修改后再查');
    r = await req('PUT', `/api/teacher/content/notices/${newId}`, {
      title: MARKER2,
      content: '已修改。关键词：' + MARKER2,
      tags: [MARKER2],
    }, token);
    check('修改成功', r.code === 200, r.code !== 200 ? JSON.stringify(r.body) : '');

    r = await req('POST', '/api/ask', { question: MARKER2 });
    check('问答能查到修改后的内容', String(r.body.text || '').includes(MARKER2),
      '修改未生效 → 内存索引未重建');

    // ---- 5. 删除后查不到 ----
    console.log('\n  5. 删除后再查');
    r = await req('DELETE', `/api/teacher/content/notices/${newId}`, null, token);
    check('删除成功', r.code === 200, r.code !== 200 ? JSON.stringify(r.body) : '');
    newId = null;

    r = await req('GET', '/api/notices');
    check('公开列表已不含该通知',
      Array.isArray(r.body) && !r.body.some((x) => x.title === MARKER || x.title === MARKER2));

  } catch (e) {
    fail++;
    failures.push('测试中断：' + e.message);
    console.log(`\n  ✗ 测试中断：${e.message}`);
  } finally {
    // ---- 清理：无论成败都要删掉测试数据 ----
    if (newId) {
      const r = await req('DELETE', `/api/teacher/content/notices/${newId}`, null, token);
      console.log(`\n  清理测试数据：${r.code === 200 ? '✓ 已删除' : '✗ 删除失败，请手动检查 ' + newId}`);
    }
  }

  // ---- 汇总 ----
  console.log('\n' + line);
  console.log(`  通过 ${pass} / ${pass + fail}`);
  console.log(line);
  if (fail === 0) {
    console.log('\n  教师端的改动能立即被学生端看到，数据同步正常。');
  } else {
    console.log('\n  失败项：');
    for (const f of failures) console.log(`    · ${f}`);
    console.log('\n  排查方向：检查 server.js 中内容写操作后是否调用了 agent.reload()');
  }
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
})();
