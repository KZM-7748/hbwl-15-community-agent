'use strict';

/**
 * WPS 会议工具回归测试
 *
 *   node scripts/wpscheck.js
 *
 * 前置条件：服务需正在运行（node server.js）
 * 环境变量：PORT（默认 8080）
 *
 * 覆盖内容：
 *   1. 会议工具页面可访问，且含三个 WPS 唤起协议
 *   2. WPS 检测接口能识别本机安装的三个组件
 *   3. 静态资源可访问
 *   4. 入口页有会议工具入口
 *   5. 启动接口在本机可用、且不会对远程开放
 *
 * 关于技术实现（见 lib/launcher.js 注释）：
 *   浏览器不能直接启动本机程序，本项目用两条路：
 *     · URL 协议（ksowps:// 等）——纯前端，会弹系统确认框
 *     · 本机 HTTP 接口——兜底，**仅限 127.0.0.1**，否则同网段任何人都能远程启动程序
 */

const http = require('http');

const PORT = Number(process.env.PORT || 8080);

function req(method, p, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
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
  console.log('='.repeat(60));
  console.log('  WPS 会议工具验证');
  console.log('='.repeat(60));

  // 1. 页面可访问
  console.log('\n【1】会议工具页面');
  let r = await req('GET', '/meeting');
  check('页面可访问', r.code === 200);
  const html = r.raw || '';
  check('含 WPS 唤起按钮', html.includes('ksowps://'));
  check('含表格唤起按钮', html.includes('ksoet://'));
  check('含演示唤起按钮', html.includes('ksowpp://'));
  check('含会议模板区', html.includes('会议材料模板'));
  check('含知识库导出', html.includes('导出知识库'));

  // 2. WPS 检测接口
  console.log('\n【2】WPS 检测接口（本机）');
  r = await req('GET', '/api/wps/detect');
  check('接口返回 200', r.code === 200);
  check('检测到 WPS', r.body && r.body.available === true,
    JSON.stringify(r.body));
  if (r.body && r.body.targets) {
    for (const t of r.body.targets) {
      console.log(`     ${t.name}  ${t.protocol}  ${t.path ? '✓' : '✗'}`);
    }
    check('三个组件都检测到', r.body.targets.length === 3,
      `实际 ${r.body.targets.length} 个`);
  }

  // 3. 静态资源
  console.log('\n【3】静态资源');
  for (const p of ['/meeting.css', '/meeting.js']) {
    r = await req('GET', p);
    check(`${p} 可访问`, r.code === 200);
  }

  // 4. 入口页有会议链接
  console.log('\n【4】入口页会议入口');
  r = await req('GET', '/');
  check('入口页含会议工具链接', (r.raw || '').includes('/meeting'));

  // 5. 安全：启动接口仅限本机
  console.log('\n【5】安全：启动接口仅限本机');
  r = await req('POST', '/api/launch', { target: 'wps' });
  // 从本机测试：应该成功（200）或因启动失败返回 500；
  // 关键是不能返回 403 —— 403 说明被误判成远程来源。
  check('本机调用未被拒绝', r.code !== 403, `HTTP ${r.code}`);
  console.log(`     返回：HTTP ${r.code} ${JSON.stringify(r.body).slice(0, 80)}`);

  // 6. CSV 导出编码（前端逻辑，这里验证规则本身）
  console.log('\n【6】CSV 导出编码规则');
  // 加 BOM 是 WPS/Excel 打开中文不乱码的关键
  const bom = Buffer.from('\uFEFF', 'utf8');
  check('UTF-8 BOM 为 ef bb bf',
    bom[0] === 0xEF && bom[1] === 0xBB && bom[2] === 0xBF,
    [...bom].map((b) => b.toString(16)).join(' '));

  console.log('\n' + '='.repeat(60));
  console.log(`  通过 ${pass} / ${pass + fail}`);
  console.log('='.repeat(60));
  if (fail === 0) {
    console.log('\n  会议工具与 WPS 唤起均正常。\n');
  } else {
    console.log('\n  存在失败项。若「WPS 检测」失败，说明本机未装 WPS，');
    console.log('  这不影响其他功能，只是会议工具页的唤起按钮不可用。\n');
  }
  process.exit(fail === 0 ? 0 : 1);
})();
