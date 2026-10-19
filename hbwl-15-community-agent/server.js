'use strict';

/**
 * 15栋一站式社区智能体 —— 零依赖 HTTP 服务器
 *
 * 只用 Node 内置模块，便于在社区一体机/内网服务器上长期运行：
 *   node server.js
 *
 * 环境变量：
 *   PORT           监听端口（默认 8080）
 *   HOST           监听地址（默认 0.0.0.0，便于手机端同网访问）
 *   TEACHER_PIN    教师端口令（默认见 data/_config.json）
 *   LLM_API_KEY    预留位：当前版本不调用大模型，设置此项无实际作用
 *                  （接入方案见「人工智能接入说明.md」）
 *
 * 角色：
 *   /            入口页（选择学生端 / 教师端）
 *   /student     学生端（问答）
 *   /teacher     教师端（看板 + 内容管理，需口令）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { CommunityAgent } = require('./lib/agent');
const { ContentManager } = require('./lib/content');
const qrcode = require('./lib/qrcode');
const launcher = require('./lib/launcher');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'data', '_config.json');

const agent = new CommunityAgent();
const content = new ContentManager();

// ---------- 对外访问地址 ----------
// 用于生成二维码与展示给同学。优先级：
//   1. 环境变量 PUBLIC_URL（学院若配了域名，设这个最省事）
//   2. 请求头 Host（同学用什么地址访问，二维码就指向什么地址）
//   3. 本机第一个可用的局域网 IP
function pickLanAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      candidates.push(ni.address);
    }
  }
  // 优先 192.168 / 10. / 172.16-31（真正的局域网段）
  const lan = candidates.find((a) =>
    a.startsWith('192.168.') || a.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a));
  return lan || candidates[0] || 'localhost';
}

const PUBLIC_URL = process.env.PUBLIC_URL || '';

/** 推断本次请求应使用的对外基地址 */
function baseUrlFor(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) {
    // 若 Host 是 localhost，替换为局域网 IP，方便直接分享给同学
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      const port = host.includes(':') ? host.split(':')[1] : PORT;
      return `http://${pickLanAddress()}:${port}`;
    }
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${host}`;
  }
  return `http://${pickLanAddress()}:${PORT}`;
}

// ---------- 教师端口令 ----------

function loadConfig() {
  const defaults = {
    teacherPin: 'hbuas2026',
    siteName: '15栋一站式社区智能体',
    notice: '',
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...defaults, ...raw };
  } catch {
    // 首次运行：写出默认配置，方便学院直接编辑
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2) + '\n', 'utf8');
    } catch { /* 只读环境下忽略 */ }
    return defaults;
  }
}

let config = loadConfig();
const TEACHER_PIN = process.env.TEACHER_PIN || config.teacherPin;

// 会话令牌：内存保存，进程重启即失效（比持久化更安全）
const sessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;   // 8 小时

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function checkToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

// 定时清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (now > exp) sessions.delete(t);
}, 30 * 60 * 1000).unref();

// ---------- 简易速率限制 ----------

const rateBuckets = new Map();
function rateLimited(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const b = rateBuckets.get(ip) || { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count++;
  rateBuckets.set(ip, b);
  return b.count > limit;
}

// ---------- 静态文件 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// 页面路由 → 文件
const PAGES = {
  '/': 'index.html',
  '/student': 'student.html',
  '/teacher': 'teacher.html',
  '/meeting': 'meeting.html',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);

  // 页面路由
  if (PAGES[rel]) rel = '/' + PAGES[rel];
  else if (rel === '/index.html' || rel === '/student.html' ||
           rel === '/teacher.html' || rel === '/meeting.html') {
    // 直接访问 html 也允许
  } else if (!path.extname(rel)) {
    // 未知的无扩展名路径 → 回入口页
    rel = '/index.html';
  }

  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
    }).end(data);
  });
}

// ---------- 请求体 ----------

function readBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }).end(body);
}

// ---------- 服务器 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const ip = req.socket.remoteAddress || 'unknown';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  try {
    // ================= 公开接口 =================

    // --- 提问 ---
    if (p === '/api/ask' && req.method === 'POST') {
      if (rateLimited(ip)) { sendJSON(res, 429, { error: '请求过于频繁，请稍后再试' }); return; }
      const body = await readBody(req);
      const question = String(body.question || '').slice(0, 500);
      const answer = agent.ask(question, { source: body.source || 'web' });
      // 记录问答日志，供教师端看板统计（含低置信度标记）
      if (question.trim()) {
        content.logQuery(question, answer.intent, answer.verified, answer.lowConfidence);
      }
      sendJSON(res, 200, answer);
      return;
    }

    // --- 学生对回答的反馈（有用 / 没用）---
    // 比「未命中」更有价值：能发现「答了但答错」的情况
    if (p === '/api/feedback' && req.method === 'POST') {
      if (rateLimited(ip, 30, 60000)) { sendJSON(res, 429, { error: '请求过于频繁' }); return; }
      const body = await readBody(req);
      const ok = content.logFeedback({
        question: body.question,
        helpful: body.helpful === true,
        intent: body.intent,
        answerHead: body.answerHead,
      });
      sendJSON(res, ok ? 200 : 500, ok ? { ok: true } : { error: '记录失败' });
      return;
    }

    // --- 本机办公软件（WPS）检测 ---
    // 只允许本机访问：这个接口会暴露本机安装路径
    if (p === '/api/wps/detect' && req.method === 'GET') {
      if (!launcher.isLocalRequest(req)) {
        sendJSON(res, 403, { error: '仅限本机访问', available: false });
        return;
      }
      sendJSON(res, 200, launcher.detect());
      return;
    }

    // --- 唤起本机程序（WPS 等）---
    // 安全关键：**必须**限制本机来源。
    // 服务默认监听 0.0.0.0（同学要从手机访问），
    // 若此接口不限制，同网段任何人构造请求就能在你的电脑上启动程序。
    if (p === '/api/launch' && req.method === 'POST') {
      if (!launcher.isLocalRequest(req)) {
        sendJSON(res, 403, { error: '仅限本机操作。远程设备无法唤起本机程序。' });
        return;
      }
      const body = await readBody(req);
      const target = String(body.target || 'wps');
      const r = launcher.launch(target);
      sendJSON(res, r.ok ? 200 : 500, r);
      return;
    }

    if (p === '/api/stats' && req.method === 'GET') { sendJSON(res, 200, agent.stats()); return; }
    if (p === '/api/notices' && req.method === 'GET') {
      const list = agent.notices.slice().sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return String(b.date).localeCompare(String(a.date));
      });
      sendJSON(res, 200, list); return;
    }
    if (p === '/api/activities' && req.method === 'GET') {
      sendJSON(res, 200, agent.activities.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))));
      return;
    }
    if (p === '/api/venues' && req.method === 'GET') { sendJSON(res, 200, agent.venues); return; }
    if (p === '/api/faqs' && req.method === 'GET') {
      sendJSON(res, 200, agent.faqs.map((f) => ({ id: f.id, category: f.category, question: f.question })));
      return;
    }
    if (p === '/api/health' && req.method === 'GET') {
      sendJSON(res, 200, {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        version: require('./package.json').version,
        // 知识库版本号：教师端每次改动会递增，可用于确认内存数据是否为最新
        knowledgeRevision: agent.revision,
        knowledgeLoadedAt: agent.loadedAt,
      });
      return;
    }

    // --- 访问信息：给同学看的网址 + 手机端二维码 ---
    // 一体机大屏右下角显示二维码，同学扫码即可在手机上打开学生端。
    if (p === '/api/access' && req.method === 'GET') {
      const base = baseUrlFor(req);
      const studentUrl = `${base}/student`;
      let svg = '';
      try {
        svg = qrcode.toSVG(studentUrl, { scale: 6, quiet: 3, dark: '#143a23' });
      } catch (e) {
        // 内容过长时不影响接口可用性，仅不返回二维码
        svg = '';
      }
      sendJSON(res, 200, {
        baseUrl: base,
        studentUrl,
        teacherUrl: `${base}/teacher`,
        qrSvg: svg,
        lanAddresses: (() => {
          const nets = os.networkInterfaces();
          const out = [];
          for (const name of Object.keys(nets)) {
            for (const ni of nets[name] || []) {
              if (ni.family !== 'IPv4' || ni.internal) continue;
              if (ni.address.startsWith('169.254.')) continue;
              out.push({ name, address: ni.address });
            }
          }
          return out;
        })(),
      });
      return;
    }

    // --- 二维码图片（SVG），可直接用于 <img src="/api/qr?path=/student"> ---
    if (p === '/api/qr' && req.method === 'GET') {
      const target = url.searchParams.get('path') || '/student';
      const base = url.searchParams.get('base') || baseUrlFor(req);
      const full = base.replace(/\/+$/, '') + (target.startsWith('/') ? target : '/' + target);
      try {
        const svg = qrcode.toSVG(full, {
          scale: Math.min(Math.max(Number(url.searchParams.get('scale')) || 8, 2), 20),
          quiet: 4,
        });
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        }).end(svg);
      } catch (e) {
        sendJSON(res, 400, { error: '无法生成二维码：' + e.message });
      }
      return;
    }

    // ================= 教师端接口 =================

    // --- 登录 ---
    if (p === '/api/teacher/login' && req.method === 'POST') {
      if (rateLimited(ip, 10, 60000)) {
        sendJSON(res, 429, { error: '尝试过于频繁，请稍后再试' });
        return;
      }
      const body = await readBody(req);
      const pin = String(body.pin || '');
      // 定长比较，避免时序侧信道
      const a = Buffer.from(pin.padEnd(64, '\0'));
      const b = Buffer.from(String(TEACHER_PIN).padEnd(64, '\0'));
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) { sendJSON(res, 401, { error: '口令错误' }); return; }
      sendJSON(res, 200, { token: issueToken(), siteName: config.siteName });
      return;
    }

    // --- 登出 ---
    if (p === '/api/teacher/logout' && req.method === 'POST') {
      const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
      sessions.delete(token);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // 以下教师端接口均需鉴权
    if (p.startsWith('/api/teacher/')) {
      if (!checkToken(req)) { sendJSON(res, 401, { error: '未登录或会话已过期' }); return; }

      // --- 数据看板 ---
      if (p === '/api/teacher/dashboard' && req.method === 'GET') {
        const days = Math.min(Number(url.searchParams.get('days') || 7), 90);
        sendJSON(res, 200, content.dashboard(days));
        return;
      }

      // --- 来源清单 ---
      if (p === '/api/teacher/sources' && req.method === 'GET') {
        sendJSON(res, 200, content.sources());
        return;
      }

      // --- 内容列表 / 新增 ---
      const listMatch = p.match(/^\/api\/teacher\/content\/(notices|faqs|activities|venues)$/);
      if (listMatch) {
        const kind = listMatch[1];
        if (req.method === 'GET') { sendJSON(res, 200, content.list(kind)); return; }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const r = content.create(kind, body);
          // 写入成功后立即重建内存索引，否则学生端查不到新内容
          if (r.ok) agent.reload();
          sendJSON(res, r.ok ? 200 : 400, r.ok ? { ...r, revision: agent.revision } : r);
          return;
        }
      }

      // --- 单条：修改 / 删除 ---
      const itemMatch = p.match(/^\/api\/teacher\/content\/(notices|faqs|activities|venues)\/([\w-]+)$/);
      if (itemMatch) {
        const kind = itemMatch[1];
        const id = itemMatch[2];
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const r = content.update(kind, id, body);
          if (r.ok) agent.reload();
          sendJSON(res, r.ok ? 200 : 400, r.ok ? { ...r, revision: agent.revision } : r);
          return;
        }
        if (req.method === 'DELETE') {
          const r = content.remove(kind, id);
          if (r.ok) agent.reload();
          sendJSON(res, r.ok ? 200 : 400, r.ok ? { ...r, revision: agent.revision } : r);
          return;
        }
      }

      // --- 清空问答日志 ---
      if (p === '/api/teacher/logs' && req.method === 'DELETE') {
        sendJSON(res, 200, { ok: true, cleared: content.clearLogs() });
        return;
      }
    }

    // ================= 静态资源 =================
    if (req.method === 'GET') { serveStatic(req, res, p); return; }

    sendJSON(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    sendJSON(res, 400, { error: err.message || '请求处理失败' });
  }
});

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        addrs.push(net.address);
      }
    }
  }
  const lan = pickLanAddress();

  const line = '='.repeat(62);
  console.log(line);
  console.log('  湖北文理学院 · 计算机工程学院');
  console.log('  15栋一站式社区智能体  已启动');
  console.log(line);
  console.log('  本机访问：');
  console.log(`    入口页   http://localhost:${PORT}`);
  console.log(`    学生端   http://localhost:${PORT}/student`);
  console.log(`    教师端   http://localhost:${PORT}/teacher`);
  console.log('');
  console.log('  ★ 分享给同学（需在同一网络）：');
  console.log(`    http://${lan}:${PORT}/student`);
  if (PUBLIC_URL) console.log(`    已配置对外地址：${PUBLIC_URL}`);
  console.log('');
  if (addrs.length > 1) {
    console.log('  本机其他地址：');
    for (const a of addrs) if (a !== lan) console.log(`    http://${a}:${PORT}`);
    console.log('');
  }
  console.log(line);
  console.log(`  知识库：通知 ${agent.notices.length} · FAQ ${agent.faqs.length}`);
  console.log(`          活动 ${agent.activities.length} · 场所 ${agent.venues.length}`);
  console.log(`  教师端口令：${process.env.TEACHER_PIN ? '（来自环境变量）' : config.teacherPin}`);
  // 如实说明：当前版本不调用大模型，即使设了 LLM_API_KEY 也是离线检索
  console.log(`  问答模式：离线检索（本地知识库，不调用大模型）`);
  if (agent.llmKey) {
    console.log('           提示：检测到 LLM_API_KEY，但当前版本未接入大模型，该配置无实际作用');
  }
  console.log(line);
  console.log('  提示：若其他机器打不开，请以管理员身份放行防火墙端口：');
  console.log(`     netsh advfirewall firewall add rule name="15栋社区智能体" ^`);
  console.log(`       dir=in action=allow protocol=TCP localport=${PORT}`);
  console.log('  运行 node scripts/deploycheck.js 可做完整部署自检。');
  console.log(line);
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在停止服务…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
