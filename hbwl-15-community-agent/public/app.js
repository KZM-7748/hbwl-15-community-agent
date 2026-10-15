/* ============================================================
   15栋一站式社区智能体 · 前端逻辑
   ============================================================ */
'use strict';

const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#btnSend');
const modalEl = $('#modal');
const modalBody = $('#modalBody');

let busy = false;
let history = [];

/* ---------- 模式检测：一体机 vs 手机 ---------- */

function detectMode() {
  const saved = localStorage.getItem('hbwl-mode');
  if (saved) return saved;
  // 屏幕宽且非触屏小设备 → 一体机大屏
  const wide = window.innerWidth >= 1100;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (wide && !coarse) return 'kiosk';
  if (wide && coarse && window.innerWidth >= 1400) return 'kiosk';
  return 'phone';
}

function applyMode(mode) {
  document.body.dataset.mode = mode;
  $('#modeLabel').textContent = mode === 'kiosk' ? '大屏' : '手机';
  localStorage.setItem('hbwl-mode', mode);
}

$('#btnMode').addEventListener('click', () => {
  const cur = document.body.dataset.mode;
  applyMode(cur === 'kiosk' ? 'phone' : 'kiosk');
});

/* ---------- Markdown 轻量渲染 ---------- */

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderMarkdown(text) {
  let html = escapeHTML(text);

  // 代码 `x`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 粗体 **x**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 分隔线
  html = html.replace(/^---+$/gm, '<hr>');

  // 按行处理列表、表格与段落
  const lines = html.split('\n');
  const out = [];
  let inList = false;
  let inTable = false;

  const closeBlocks = () => {
    if (inList) { out.push('</ul>'); inList = false; }
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // 表格：| a | b |
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      // 分隔行 |---|---| 跳过
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (inList) { out.push('</ul>'); inList = false; }
      if (!inTable) {
        out.push('<table><thead><tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true;
      } else {
        out.push('<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>');
      }
      continue;
    }
    if (inTable) { out.push('</tbody></table>'); inTable = false; }

    // 列表：· • - 或 1. 2.
    if (/^[·•\-]\s+/.test(trimmed) || /^\d+[️⃣]?\s*/.test(trimmed) && /^[0-9]/.test(trimmed)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      const content = trimmed
        .replace(/^[·•\-]\s+/, '')
        .replace(/^\d+[️⃣]?\s*/, '');
      out.push('<li>' + content + '</li>');
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }

    if (trimmed === '') out.push('');
    else if (trimmed === '<hr>') out.push('<hr>');
    else out.push('<p>' + trimmed + '</p>');
  }
  closeBlocks();
  return out.join('\n');
}

/* ---------- 消息渲染 ---------- */

function addUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `
    <div class="avatar">我</div>
    <div class="bubble">${escapeHTML(text)}</div>`;
  messagesEl.appendChild(el);
  scrollDown();
}

function addBotMessage(answer) {
  const el = document.createElement('div');
  el.className = 'msg bot' + (answer.urgent ? ' urgent' : '');
  el.innerHTML = `
    <div class="avatar"><img src="/assets/xiaohui.png" alt="社区智能体"></div>
    <div class="bubble">
      <div class="bubble-text">${renderMarkdown(answer.text || '')}</div>
    </div>`;
  const bubble = el.querySelector('.bubble');

  // 来源标签
  if (answer.sources && answer.sources.length) {
    const s = document.createElement('div');
    s.className = 'sources';
    s.innerHTML = '<span>来源</span>' + answer.sources
      .map((x) => `<span class="source-tag">${escapeHTML(x.title || '')}</span>`)
      .join('');
    bubble.appendChild(s);
  }

  // 可点击卡片
  if (answer.cards && answer.cards.length) {
    const wrap = document.createElement('div');
    wrap.className = 'cards';
    for (const c of answer.cards) {
      const btn = document.createElement('button');
      btn.className = 'card';
      btn.type = 'button';
      btn.innerHTML = cardHTML(c);
      btn.addEventListener('click', () => openCard(c));
      wrap.appendChild(btn);
    }
    bubble.appendChild(wrap);
  }

  // 低置信度时的建议
  if (answer.suggestions && answer.suggestions.length) {
    const wrap = document.createElement('div');
    wrap.className = 'welcome-tips';
    wrap.style.marginTop = '12px';
    wrap.style.justifyContent = 'flex-start';
    for (const sug of answer.suggestions) {
      const b = document.createElement('button');
      b.className = 'welcome-tip';
      b.type = 'button';
      b.textContent = sug;
      b.addEventListener('click', () => { inputEl.value = sug; send(); });
      wrap.appendChild(b);
    }
    bubble.appendChild(wrap);
  }

  messagesEl.appendChild(el);
  scrollDown();
}

function cardHTML(c) {
  const badge = c.status
    ? `<span class="card-badge${c.status === '报名中' ? ' hot' : ''}">${escapeHTML(c.status)}</span>`
    : (c.pinned ? '<span class="card-badge hot">置顶</span>' : '');
  // 未核实内容明确标记，避免同学误认为已生效的官方安排
  const unverified = c.verified === false
    ? '<span class="card-badge warn">待确认</span>'
    : '';

  const metas = [];
  if (c.date) metas.push('📅 ' + escapeHTML(c.date) + (c.time && c.time !== '待定' ? ' ' + escapeHTML(c.time) : ''));
  if (c.deadline) metas.push('⏰ 截止 ' + escapeHTML(c.deadline));
  if (c.location) metas.push('📍 ' + escapeHTML(c.location));
  if (c.openHours) metas.push('🕐 ' + escapeHTML(c.openHours));
  if (c.credit && c.credit !== '无') metas.push('🎖 ' + escapeHTML(c.credit));
  if (c.enrolled != null && c.capacity) metas.push(`👥 ${c.enrolled}/${c.capacity}`);

  return `
    <div class="card-title">${escapeHTML(c.title || '')}${badge}${unverified}</div>
    ${c.summary ? `<div class="card-meta" style="margin-bottom:4px">${escapeHTML(c.summary)}</div>` : ''}
    <div class="card-meta">${metas.join('')}</div>`;
}

function openCard(c) {
  const metas = [];
  if (c.date) metas.push('📅 ' + c.date + (c.time ? ' ' + c.time : ''));
  if (c.deadline) metas.push('⏰ 截止 ' + c.deadline);
  if (c.location) metas.push('📍 ' + c.location);
  if (c.openHours) metas.push('🕐 ' + c.openHours);
  if (c.capacity) metas.push('👥 ' + c.capacity);
  if (c.booking) metas.push('📋 ' + c.booking);
  if (c.credit && c.credit !== '无') metas.push('🎖 ' + c.credit);
  if (c.organizer) metas.push('🏛 ' + c.organizer);

  modalBody.innerHTML = `
    <h3>${escapeHTML(c.title || '')}</h3>
    ${c.status || c.pinned ? `<div class="badge-row">
      ${c.status ? `<span class="card-badge${c.status === '报名中' ? ' hot' : ''}">${escapeHTML(c.status)}</span>` : ''}
      ${c.pinned ? '<span class="card-badge hot">置顶</span>' : ''}
    </div>` : ''}
    <div class="meta">${metas.join('')}</div>
    <div class="content">${escapeHTML(c.summary || c.content || '')}</div>`;
  modalEl.hidden = false;
}

modalEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-close')) modalEl.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') modalEl.hidden = true;
});

/* ---------- 欢迎屏 ---------- */

function showWelcome() {
  const tips = [
    '宿舍东西坏了怎么报修？',
    '学校的报警电话是多少？',
    '学生证丢了怎么补办？',
    '计算机工程学院有哪些专业？',
  ];
  messagesEl.innerHTML = `
    <div class="welcome">
      <img src="/assets/xiaohui.png" alt="湖北文理学院" class="welcome-icon">
      <h2>你好，我是15栋社区智能体</h2>
      <p class="motto">淡泊明志　宁静致远</p>
      <p>由计算机工程学院搭建，为社区同学提供通知查询、事务咨询、办事指引与生活服务。
         回答内容均来自学校及各二级单位官方公开信息，并标注来源。</p>
      <div class="welcome-tips">
        ${tips.map((t) => `<button class="welcome-tip" type="button">${t}</button>`).join('')}
      </div>
    </div>`;
  messagesEl.querySelectorAll('.welcome-tip').forEach((b) => {
    b.addEventListener('click', () => { inputEl.value = b.textContent; send(); });
  });
}

/* ---------- 发送 ---------- */

function scrollDown() {
  requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'msg bot';
  el.id = 'typingMsg';
  el.innerHTML = `
    <div class="avatar"><img src="/assets/xiaohui.png" alt="社区智能体"></div>
    <div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
  messagesEl.appendChild(el);
  scrollDown();
}
function hideTyping() {
  const el = document.getElementById('typingMsg');
  if (el) el.remove();
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;

  busy = true;
  sendBtn.disabled = true;
  inputEl.value = '';
  inputEl.style.height = 'auto';

  // 首次提问时移除欢迎屏
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) messagesEl.innerHTML = '';

  addUserMessage(text);
  history.push({ role: 'user', content: text });
  showTyping();

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text, source: document.body.dataset.mode }),
    });
    const data = await res.json();
    hideTyping();

    if (!res.ok) {
      addBotMessage({ text: '抱歉，服务暂时不可用：' + (data.error || '未知错误') + '\n\n请稍后再试，或到1楼服务中心咨询。' });
    } else {
      addBotMessage(data);
      history.push({ role: 'assistant', content: data.text });
    }
  } catch (err) {
    hideTyping();
    addBotMessage({
      text: '⚠️ 无法连接到智能体服务。\n\n请检查网络连接，或到 **15栋1楼社区服务中心** 咨询。',
    });
  } finally {
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

/* ---------- 事件绑定 ---------- */

sendBtn.addEventListener('click', send);

inputEl.addEventListener('keydown', (e) => {
  // Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

// 自适应高度
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
});

// 快捷卡片
document.querySelectorAll('.quick-card').forEach((b) => {
  b.addEventListener('click', () => { inputEl.value = b.dataset.q; send(); });
});

// 清空
$('#btnClear').addEventListener('click', () => {
  messagesEl.innerHTML = '';
  history = [];
  showWelcome();
});

/* ---------- 统计信息 ---------- */

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await res.json();
    $('#statsList').innerHTML = `
      <li><span>📢</span> 通知公告 ${s.notices} 条</li>
      <li><span>❓</span> 常见问题 ${s.faqs} 条</li>
      <li><span>🎯</span> 活动与计划 ${s.activities} 项</li>
      <li><span>🏠</span> 服务场所 ${s.venues} 处</li>
      <li><span>✅</span> 已核实 ${s.verified} 条 / 待确认 ${s.unverified} 条</li>
      <li><span>📄</span> 来源 ${s.sourceCount} 个官方渠道</li>
      <li><span>${s.llmEnabled ? '🧠' : '📴'}</span> ${s.llmEnabled ? '大模型增强已启用' : '离线检索模式'}</li>`;
  } catch {
    $('#statsList').innerHTML = '<li>统计信息暂不可用</li>';
  }
}

/* ---------- 手机端入口二维码 ---------- */

async function loadAccess() {
  try {
    const res = await fetch('/api/access');
    const d = await res.json();
    if (!d.qrSvg) return;

    $('#qrImg').innerHTML = d.qrSvg;
    $('#qrUrl').textContent = d.studentUrl;
    $('#qrBlock').hidden = false;

    // 放大显示：一体机场景下便于远距离扫码
    $('#btnQrBig').addEventListener('click', () => {
      const el = document.createElement('div');
      el.className = 'msg bot';
      el.style.cssText = 'align-self:center;max-width:520px;width:100%';
      el.innerHTML = `
        <div class="bubble" style="text-align:center">
          <div style="font-size:1.05em;font-weight:600;margin-bottom:12px">扫码在手机上打开学生端</div>
          <div style="width:min(340px,70vw);margin:0 auto">${d.qrSvg}</div>
          <div style="margin-top:12px;font-size:.82em;color:var(--text-dim);word-break:break-all">${escapeHTML(d.studentUrl)}</div>
          <div style="margin-top:8px;font-size:.78em;color:var(--text-light)">手机需与本机在同一网络</div>
        </div>`;
      messagesEl.innerHTML = '';
      messagesEl.appendChild(el);
      scrollDown();
    });
  } catch {
    // 二维码不可用不影响问答功能
  }
}

/* ---------- 初始化 ---------- */

applyMode(detectMode());
showWelcome();
loadStats();
loadAccess();
inputEl.focus();

// 窗口尺寸变化时重新判定（一体机旋转/投屏）
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!localStorage.getItem('hbwl-mode-user')) applyMode(detectMode());
  }, 300);
});
