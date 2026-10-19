'use strict';

/**
 * 生成「分享包」—— 把当前访问地址、二维码、使用说明打成一个文件
 *
 *   node scripts/share.js
 *
 * 用途：需要把智能体发给别人看时，不必口述网址，直接把这个 HTML 文件发过去，
 *       对方用浏览器打开就能看到可点击的网址和可扫的二维码。
 *
 * 注意：这个文件只是「入口说明」，对方仍需能访问到服务本身：
 *       · 同一 WiFi / 局域网 → 网址可用
 *       · 校外 → 需先做内网穿透或部署到公网，见 部署指南.md
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const qrcode = require('../lib/qrcode');

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.join(__dirname, '..');

/** 取本机所有可用于访问的 IPv4 */
function listAddrs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      let kind = '其他';
      if (ni.address.startsWith('192.168.') || ni.address.startsWith('10.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(ni.address)) {
        kind = 'lan';
      } else if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ni.address)) {
        kind = 'cgnat';
      }
      out.push({ name, address: ni.address, kind });
    }
  }
  // 局域网地址优先
  out.sort((a, b) => (a.kind === 'lan' ? -1 : 1) - (b.kind === 'lan' ? -1 : 1));
  return out;
}

/** 检查服务是否在跑 */
function checkAlive() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

(async () => {
  const alive = await checkAlive();
  const addrs = listAddrs();
  const lan = addrs.filter((a) => a.kind === 'lan');
  const cgnat = addrs.filter((a) => a.kind === 'cgnat');

  const primary = lan[0] || addrs[0];
  const studentUrl = primary ? `http://${primary.address}:${PORT}/student` : `http://localhost:${PORT}/student`;
  const entryUrl = primary ? `http://${primary.address}:${PORT}` : `http://localhost:${PORT}`;
  const teacherUrl = primary ? `http://${primary.address}:${PORT}/teacher` : `http://localhost:${PORT}/teacher`;

  let qrSvg = '';
  try {
    qrSvg = qrcode.toSVG(studentUrl, { scale: 7, quiet: 3, dark: '#143a23' });
  } catch (e) {
    qrSvg = '';
  }

  const now = new Date().toLocaleString('zh-CN');

  const rows = addrs.map((a) => {
    const label = a.kind === 'lan' ? '局域网（同一 WiFi 可用）'
      : a.kind === 'cgnat' ? '运营商大内网（通常外部不可访问）'
      : '其他';
    const cls = a.kind === 'lan' ? 'ok' : 'dim';
    return `<tr class="${cls}">
      <td><code>http://${esc(a.address)}:${PORT}</code></td>
      <td>${esc(a.name)}</td>
      <td>${esc(label)}</td>
    </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>15栋社区智能体 · 访问方式</title>
<style>
  :root { --g:#286840; --gd:#143a23; --gl:#eaf3ed; --bd:#e2e8e4; --tx:#1f2a24; --dim:#5f6b64; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 60px; font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         color:var(--tx); background:#f5f7f5; line-height:1.75; }
  .wrap { max-width:720px; margin:0 auto; }
  header { text-align:center; margin-bottom:28px; }
  h1 { font-size:1.5rem; color:var(--gd); margin:0 0 8px; font-weight:600; }
  .sub { color:var(--dim); font-size:.9rem; }
  .card { background:#fff; border:1px solid var(--bd); border-radius:12px; padding:24px; margin-bottom:18px;
          box-shadow:0 1px 3px rgba(20,58,35,.06); }
  .card h2 { font-size:1.02rem; color:var(--gd); margin:0 0 14px; font-weight:600;
             display:flex; align-items:center; gap:8px; }
  .card h2::before { content:""; width:3px; height:1em; background:var(--g); border-radius:2px; }
  .big-url { display:block; font-size:1.15rem; font-weight:600; color:var(--g); text-decoration:none;
             background:var(--gl); border:1px solid #d6e6dc; border-radius:9px; padding:14px 18px;
             text-align:center; word-break:break-all; margin:6px 0 12px; }
  .big-url:hover { background:#dcebe2; }
  .qr { text-align:center; }
  .qr svg { width:180px; height:180px; border:1px solid var(--bd); border-radius:9px; padding:8px; background:#fff; }
  .qr p { font-size:.84rem; color:var(--dim); margin:10px 0 0; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th, td { padding:9px 10px; text-align:left; border-bottom:1px solid var(--bd); }
  th { color:var(--dim); font-weight:500; font-size:.8rem; }
  tr.dim td { color:#9aa8a1; }
  tr.dim code { color:#9aa8a1; }
  code { font-family:ui-monospace,Consolas,monospace; font-size:.88em;
         background:var(--gl); color:var(--gd); padding:2px 6px; border-radius:4px; }
  tr.dim code { background:#f3f5f4; }
  .note { background:#fff8e6; border:1px solid #f0dfb0; border-radius:9px; padding:14px 18px;
          font-size:.85rem; color:#6b5320; margin-top:14px; }
  .note b { color:#8a6a15; }
  .steps { counter-reset:s; list-style:none; padding:0; margin:0; }
  .steps li { counter-increment:s; position:relative; padding-left:34px; margin-bottom:11px; font-size:.9rem; }
  .steps li::before { content:counter(s); position:absolute; left:0; top:1px; width:22px; height:22px;
                      background:var(--g); color:#fff; border-radius:50%; text-align:center;
                      line-height:22px; font-size:.78rem; font-weight:600; }
  .status { display:inline-block; font-size:.78rem; padding:3px 10px; border-radius:20px;
            background:#e8f5ee; color:#0f7b46; border:1px solid #bfe3ce; }
  .status.bad { background:#fef2f2; color:#b91c1c; border-color:#fecaca; }
  footer { text-align:center; font-size:.78rem; color:#9aa8a1; margin-top:30px; }
  @media (max-width:520px) { body { padding:20px 14px 40px; } .card { padding:18px; } }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1>15栋一站式社区智能体</h1>
    <div class="sub">湖北文理学院 · 计算机工程学院</div>
  </header>

  <div class="card">
    <h2>服务状态</h2>
    <p style="margin:0 0 10px">
      ${alive
        ? '<span class="status">✓ 服务正在运行</span>'
        : '<span class="status bad">✗ 服务未运行</span>'}
    </p>
    <p style="margin:0;font-size:.85rem;color:var(--dim)">
      ${alive
        ? '可以正常访问。若对方打不开，多半是防火墙未放行，或不在同一网络。'
        : '请先启动服务（双击 <code>启动.bat</code> 或运行 <code>node server.js</code>），再让对方访问。'}
    </p>
  </div>

  <div class="card">
    <h2>手机扫码进入（推荐）</h2>
    <div class="qr">
      ${qrSvg || '<p style="color:#b91c1c">二维码生成失败</p>'}
      <p>手机需与本机连同一个 WiFi / 局域网</p>
    </div>
  </div>

  <div class="card">
    <h2>直接发这个网址给学生</h2>
    <a class="big-url" href="${esc(studentUrl)}" target="_blank" rel="noopener">${esc(studentUrl)}</a>
    <p style="margin:0;font-size:.85rem;color:var(--dim)">
      学生端：查通知、问办事流程、看活动。<br>
      入口页（可选角色）：<a href="${esc(entryUrl)}" target="_blank" rel="noopener" style="color:var(--g)">${esc(entryUrl)}</a>
    </p>
  </div>

  <div class="card">
    <h2>教师端（需要口令）</h2>
    <a class="big-url" href="${esc(teacherUrl)}" target="_blank" rel="noopener">${esc(teacherUrl)}</a>
    <p style="margin:0;font-size:.85rem;color:var(--dim)">
      数据看板 + 知识库维护。口令见 <code>data/_config.json</code> 的 <code>teacherPin</code>。
      <b>正式使用前请修改默认口令。</b>
    </p>
  </div>

  <div class="card">
    <h2>本机所有可访问地址</h2>
    <table>
      <thead><tr><th>网址</th><th>网卡</th><th>可用范围</th></tr></thead>
      <tbody>
${rows || '<tr><td colspan="3" style="color:#9aa8a1">未找到可用 IP</td></tr>'}
      </tbody>
    </table>
    <div class="note">
      <b>关于访问范围：</b><br>
      · <b>同一 WiFi / 局域网</b>的电脑和手机，用「192.168.x.x」或「10.x.x.x」开头的网址即可访问。<br>
      · <b>校外或不同网络</b>的人访问不了这些地址——需要先做内网穿透或部署到公网，见 <code>部署指南.md</code>。<br>
      · 若同一 WiFi 也打不开，通常是 <b>Windows 防火墙</b>没放行，需以管理员身份运行：<br>
      <code>netsh advfirewall firewall add rule name="15栋社区智能体" dir=in action=allow protocol=TCP localport=${PORT}</code>
    </div>
  </div>

  <div class="card">
    <h2>对方打不开？按顺序检查</h2>
    <ol class="steps">
      <li>确认服务在运行——看最上面的「服务状态」是否为绿色。</li>
      <li>确认在同一网络——手机连的是不是和电脑同一个 WiFi？</li>
      <li>检查防火墙——以管理员身份执行上面那条 <code>netsh</code> 命令。</li>
      <li>确认网址没抄错——IP 可能因重启而变化，重新运行 <code>node scripts/share.js</code> 生成新的。</li>
      <li>对方在校外——这些局域网地址对他无效，需按 <code>部署指南.md</code> 做公网方案。</li>
    </ol>
  </div>

  <footer>
    生成时间：${esc(now)}<br>
    本文件由 <code>node scripts/share.js</code> 生成，可直接发给他人。
  </footer>

</div>
</body>
</html>`;

  const outFile = path.join(ROOT, '分享给他人.html');
  fs.writeFileSync(outFile, html, 'utf8');

  // 终端摘要
  console.log('='.repeat(60));
  console.log('  已生成分享页：分享给他人.html');
  console.log('='.repeat(60));
  console.log(`  服务状态：${alive ? '运行中' : '未运行（请先启动）'}`);
  console.log('');
  console.log('  学生端网址（可直接发给人）：');
  console.log(`    ${studentUrl}`);
  console.log('');
  console.log('  教师端网址：');
  console.log(`    ${teacherUrl}`);
  console.log('');
  if (cgnat.length) {
    console.log('  注意：以下地址属运营商大内网，外部通常无法访问，仅作参考：');
    for (const a of cgnat) console.log(`    http://${a.address}:${PORT}`);
    console.log('');
  }
  console.log('  使用方式：');
  console.log('    1. 把这个 HTML 文件发给对方（微信/QQ 传文件均可）');
  console.log('    2. 对方用浏览器打开，即可看到可点击的网址和二维码');
  console.log('');
  console.log('  前提：对方需与本机在同一网络（同一 WiFi / 局域网）。');
  console.log('        校外访问需先做内网穿透，见 部署指南.md。');
  console.log('='.repeat(60));
  console.log(`  文件位置：${outFile}`);
  console.log('');
})();
