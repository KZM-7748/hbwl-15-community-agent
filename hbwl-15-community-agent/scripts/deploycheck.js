'use strict';

/**
 * 部署自检 —— 在目标机器上运行，检查这个网址能否被别人访问
 *
 *   node scripts/deploycheck.js
 *
 * 检查项：
 *   1. Node.js 版本是否满足要求
 *   2. 服务是否在运行、是否监听 0.0.0.0（只听 127.0.0.1 则外部无法访问）
 *   3. 本机所有可用 IP，逐个给出可分享的网址
 *   4. 端口是否被其他程序占用
 *   5. 防火墙是否有放行规则（Windows）
 *   6. IP 是否为动态分配（重启可能变化，导致网址失效）
 *   7. 教师端口令是否仍为默认值（安全提醒）
 */

const os = require('os');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.join(__dirname, '..');

const results = [];
function ok(msg, detail) { results.push({ level: 'ok', msg, detail }); }
function warn(msg, detail) { results.push({ level: 'warn', msg, detail }); }
function bad(msg, detail) { results.push({ level: 'bad', msg, detail }); }
function info(msg, detail) { results.push({ level: 'info', msg, detail }); }

// ---------- 1. Node 版本 ----------
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`Node.js 版本 ${process.versions.node}`);
  else bad(`Node.js 版本过低：${process.versions.node}`, '需要 18 或更高版本，请从 nodejs.org 升级');
}

// ---------- 2. 端口监听情况 ----------
function checkListening() {
  return new Promise((resolve) => {
    // 通过连接本机端口判断服务是否在跑
    const sock = net.connect({ host: '127.0.0.1', port: PORT, timeout: 2000 });
    sock.on('connect', () => {
      sock.destroy();
      ok(`服务正在运行（端口 ${PORT} 可连接）`);
      resolve(true);
    });
    sock.on('timeout', () => { sock.destroy(); bad(`端口 ${PORT} 连接超时`, '服务可能未启动或未响应'); resolve(false); });
    sock.on('error', () => { bad(`端口 ${PORT} 无法连接`, `服务未启动。请先运行 node server.js 或双击 启动.bat`); resolve(false); });
  });
}

/** 检查是否监听在所有网卡（0.0.0.0）上 */
function checkBindAll() {
  return new Promise((resolve) => {
    const addrs = listIPv4();
    if (!addrs.length) { warn('未找到可用的局域网 IP'); resolve(); return; }

    let pending = addrs.length;
    let anyOk = false;
    for (const a of addrs) {
      const sock = net.connect({ host: a.address, port: PORT, timeout: 2500 });
      sock.on('connect', () => { anyOk = true; sock.destroy(); done(); });
      sock.on('timeout', () => { sock.destroy(); done(); });
      sock.on('error', () => { sock.destroy(); done(); });
    }
    function done() {
      pending--;
      if (pending > 0) return;
      if (anyOk) ok('服务监听在所有网卡上（0.0.0.0），外部可访问');
      else bad('服务未监听在局域网地址上', '若 HOST 设为 127.0.0.1，其他机器将无法访问。请改用 HOST=0.0.0.0');
      resolve();
    }
  });
}

// ---------- 3. 列出可用 IP ----------
function listIPv4() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      // 排除 169.254.x.x（链路本地，不可用于访问）
      if (ni.address.startsWith('169.254.')) continue;
      out.push({ name, address: ni.address, cidr: ni.cidr });
    }
  }
  return out;
}

function reportAddresses() {
  const addrs = listIPv4();
  if (!addrs.length) { warn('未找到可用于访问的 IP 地址', '请确认已连接网络'); return; }

  info('可分享给同学的网址：');
  for (const a of addrs) {
    let kind = '';
    if (a.address.startsWith('192.168.') || a.address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) {
      kind = '（局域网，同一 WiFi/网段可访问）';
    } else if (a.address.startsWith('100.64.') || a.address.startsWith('100.65.') ||
               a.address.startsWith('100.66.') || a.address.startsWith('100.67.')) {
      kind = '（运营商大内网 CGNAT，通常无法被外部主动访问）';
    } else {
      kind = '（公网或校园网地址）';
    }
    info(`   http://${a.address}:${PORT}   [${a.name}] ${kind}`);
  }
}

// ---------- 4. 端口占用 ----------
// 注意：如果服务本身正在运行，端口被占用是正常的，不应报警。
// 只有在「服务没在跑」却仍被占用时，才说明有别的程序占了这个端口。
function checkPortConflict(serviceRunning) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (serviceRunning) {
          info(`端口 ${PORT} 由本智能体占用（正常）`);
        } else {
          bad(`端口 ${PORT} 被其他程序占用`,
            `本智能体无法启动。请改用其他端口：PORT=8081 node server.js`);
        }
      } else {
        warn(`端口 ${PORT} 检测异常：${err.code}`);
      }
      resolve();
    });
    tester.once('listening', () => { tester.close(); resolve(); });
    tester.listen(PORT, '0.0.0.0');
  });
}

// ---------- 5. 防火墙（Windows） ----------
// netsh 与 Get-NetFirewallProfile 都需要管理员权限，
// 普通用户下读不到——这是权限边界，不是故障，因此提示要给出可执行的命令。
function checkFirewall() {
  if (process.platform !== 'win32') {
    info('非 Windows 系统，跳过防火墙检查', 'Linux 请确认 ufw/iptables 已放行该端口');
    return;
  }

  let status = null;
  try {
    const out = execSync('netsh advfirewall show allprofiles state', {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 解析形如 "Domain Profile Settings: ... State ON"
    const onCount = (out.match(/State\s+ON/gi) || []).length;
    const offCount = (out.match(/State\s+OFF/gi) || []).length;
    if (onCount > 0) status = `已开启（${onCount} 个配置文件）`;
    else if (offCount > 0) status = '已关闭';
  } catch (e) {
    const msg = String((e.stderr || '') + (e.stdout || '') + (e.message || ''));
    if (/elevation|管理员|administrator/i.test(msg)) status = 'need-admin';
  }

  if (status === '已关闭') {
    ok('Windows 防火墙已关闭，入站无需额外放行');
    return;
  }

  if (status === null) {
    warn('无法确定防火墙状态（需要管理员权限）',
      `请以管理员身份运行下面这条命令放行入站端口，否则其他机器连不上：\n` +
      `      netsh advfirewall firewall add rule name="15栋社区智能体" dir=in action=allow protocol=TCP localport=${PORT}`);
    return;
  }

  warn(`Windows 防火墙${status}`,
    `需放行入站 ${PORT} 端口，否则其他机器连不上。\n` +
    `      以管理员身份运行（右键「终端」→ 以管理员身份运行）：\n` +
    `      netsh advfirewall firewall add rule name="15栋社区智能体" dir=in action=allow protocol=TCP localport=${PORT}`);
}

// ---------- 6. IP 是否动态 ----------
function checkDhcp() {
  if (process.platform !== 'win32') return;
  try {
    const ps = 'Get-NetIPInterface -AddressFamily IPv4 | Where-Object {$_.Dhcp -eq "Enabled"} | ' +
               'Select-Object InterfaceAlias | ConvertTo-Json -Compress';
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 15000 });
    if (!out.trim() || out.trim() === 'null') {
      info('未检测到启用 DHCP 的网卡（IP 看起来是静态的）');
    } else {
      const arr = JSON.parse(out);
      const list = Array.isArray(arr) ? arr : [arr];
      warn(`以下网卡使用 DHCP 动态获取 IP：${list.map((x) => x.InterfaceAlias).join('、')}`,
        '重启或断网后 IP 可能变化，网址会失效。建议在路由器/网络设置里为该设备绑定固定 IP，' +
        '或给机器设置一个校园网内的静态 IP');
    }
  } catch { /* 忽略 */ }
}

// ---------- 7. 教师端口令 ----------
function checkPin() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '_config.json'), 'utf8'));
    if (!process.env.TEACHER_PIN && cfg.teacherPin === 'hbuas2026') {
      bad('教师端口令仍是默认值 hbuas2026',
        '任何知道这个默认口令的人都能修改知识库。请修改 data/_config.json 的 teacherPin，' +
        '或设置环境变量 TEACHER_PIN');
    } else {
      ok('教师端口令已自定义');
    }
  } catch {
    warn('无法读取 data/_config.json');
  }
}

// ---------- 8. 实际 HTTP 响应 ----------
function checkHttp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) ok('服务响应正常（/api/health 返回 200）');
        else warn(`服务返回状态码 ${res.statusCode}`);
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
  });
}

// ---------- 输出 ----------
const ICON = { ok: '✓', warn: '!', bad: '✗', info: '·' };

function print() {
  const line = '='.repeat(66);
  console.log(line);
  console.log('  15栋社区智能体 · 部署自检');
  console.log(line);

  for (const r of results) {
    const mark = ICON[r.level];
    console.log(`  ${mark} ${r.msg}`);
    if (r.detail) {
      for (const l of String(r.detail).split('\n')) console.log(`      ${l}`);
    }
  }

  const badCount = results.filter((r) => r.level === 'bad').length;
  const warnCount = results.filter((r) => r.level === 'warn').length;

  console.log(line);
  if (badCount) {
    console.log(`  ${badCount} 项需要处理，${warnCount} 项提醒 —— 请先解决 ✗ 项`);
  } else if (warnCount) {
    console.log(`  基本就绪，${warnCount} 项提醒建议确认`);
  } else {
    console.log('  全部通过，可以对外提供服务');
  }
  console.log(line);

  // 给出结论式建议
  const addrs = listIPv4();
  const lan = addrs.filter((a) =>
    a.address.startsWith('192.168.') || a.address.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a.address));
  if (lan.length && badCount === 0) {
    console.log('\n  同学可以在同一网络下访问：');
    for (const a of lan) console.log(`    http://${a.address}:${PORT}`);
  }
  console.log('');
}

(async function main() {
  checkNode();
  const running = await checkListening();
  if (running) {
    await checkBindAll();
    await checkHttp();
  }
  await checkPortConflict(running);
  reportAddresses();
  checkFirewall();
  checkDhcp();
  checkPin();
  print();
})();
