/* ============================================================
   教师端 · 管理后台逻辑
   ============================================================ */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let token = sessionStorage.getItem('hbwl-teacher-token') || '';
let currentView = 'dashboard';
let currentKind = 'notices';
let editing = null;      // { kind, id | null, data }

const KIND_META = {
  notices: { title: '通知公告', prefix: 'n' },
  activities: { title: '活动管理', prefix: 'a' },
  faqs: { title: '常见问题', prefix: 'f' },
  venues: { title: '服务场所', prefix: 'v' },
};

/* ---------- 工具 ---------- */

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2800);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    logout(true);
    throw new Error('登录已过期，请重新登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.errors ? data.errors.join('；') : (data.error || '请求失败');
    throw new Error(msg);
  }
  return data;
}

/* ---------- 登录 ---------- */

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pinInput').value.trim();
  if (!pin) return;
  const btn = $('#btnLogin');
  btn.disabled = true;
  btn.textContent = '登录中…';
  $('#loginError').hidden = true;
  try {
    const r = await api('/api/teacher/login', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    token = r.token;
    sessionStorage.setItem('hbwl-teacher-token', token);
    enterConsole();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').hidden = false;
    $('#pinInput').value = '';
    $('#pinInput').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
});

function logout(silent) {
  if (!silent && token) {
    api('/api/teacher/logout', { method: 'POST' }).catch(() => {});
  }
  token = '';
  sessionStorage.removeItem('hbwl-teacher-token');
  $('#mainView').hidden = true;
  $('#loginView').hidden = false;
  $('#pinInput').value = '';
  if (!silent) $('#pinInput').focus();
}

$('#btnLogout').addEventListener('click', () => logout(false));

function enterConsole() {
  $('#loginView').hidden = true;
  $('#mainView').hidden = false;
  loadView('dashboard');
}

/* ---------- 导航 ---------- */

$$('.nav-item').forEach((b) => {
  b.addEventListener('click', () => loadView(b.dataset.view));
});

function setActiveNav(view) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

function loadView(view) {
  currentView = view;
  setActiveNav(view);
  $$('.view').forEach((v) => { v.hidden = true; });

  if (view === 'dashboard') {
    $('#view-dashboard').hidden = false;
    loadDashboard();
  } else if (view === 'pending') {
    $('#view-pending').hidden = false;
    loadPending();
  } else if (view === 'sources') {
    $('#view-sources').hidden = false;
    loadSources();
  } else {
    currentKind = view;
    $('#view-content').hidden = false;
    $('#contentTitle').textContent = KIND_META[view].title;
    loadContent(view);
  }
}

/* ---------- 看板 ---------- */

async function loadDashboard() {
  const days = $('#daysSelect').value;
  try {
    const d = await api('/api/teacher/dashboard?days=' + days);

    $('#statGrid').innerHTML = `
      <div class="stat-card">
        <div class="stat-label">知识库总量</div>
        <div class="stat-value">${d.total}<span class="stat-unit">条</span></div>
      </div>
      <div class="stat-card accent">
        <div class="stat-label">已核实</div>
        <div class="stat-value">${d.verified}<span class="stat-unit">条</span></div>
      </div>
      <div class="stat-card ${d.unverified ? 'warn' : ''}">
        <div class="stat-label">待确认</div>
        <div class="stat-value">${d.unverified}<span class="stat-unit">条</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">累计提问</div>
        <div class="stat-value">${d.queries.total}<span class="stat-unit">次</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">官方来源</div>
        <div class="stat-value">${d.sourceCount}<span class="stat-unit">个</span></div>
      </div>`;

    // 待确认徽章
    const badge = $('#pendingBadge');
    badge.textContent = d.pending.length;
    badge.classList.toggle('show', d.pending.length > 0);

    // 高频问题
    $('#topQuestions').innerHTML = d.queries.topQuestions.length
      ? d.queries.topQuestions.map((x, i) => `
        <div class="list-row">
          <span class="rank">${i + 1}</span>
          <span class="qtext">${escapeHTML(x.q)}</span>
          <span class="qcount">${x.n} 次</span>
        </div>`).join('')
      : '<div class="list-empty">暂无提问记录。<br>同学开始使用后，这里会显示高频问题。</div>';

    // 待补充清单：未命中 + 被点「没用」，每条都能一键转成 FAQ
    const gaps = d.pendingAnswers || [];
    $('#topMissed').innerHTML = gaps.length
      ? gaps.map((x, i) => {
        // 标注来源：没答上 / 可能答错 / 答了但被点没用
        const tags = [];
        if (x.missed) tags.push(`<span class="tag plain">未命中 ${x.missed} 次</span>`);
        if (x.low) tags.push(`<span class="tag hot">可能答错 ${x.low} 次</span>`);
        if (x.unhelpful) tags.push(`<span class="tag warn">被点没用 ${x.unhelpful} 次</span>`);
        return `
        <div class="list-row missed-row">
          <span class="rank">${i + 1}</span>
          <span class="qtext">
            ${escapeHTML(x.q)}
            <div style="margin-top:4px">${tags.join(' ')}</div>
            ${x.head ? `<div style="color:var(--text-light);font-size:.92em;margin-top:2px">当时回答：${escapeHTML(x.head)}</div>` : ''}
          </span>
          <button class="mini-btn add-faq" type="button"
                  data-q="${escapeHTML(x.q)}">补充答案</button>
        </div>`;
      }).join('')
      : '<div class="list-empty">暂无待补充问题。<br>同学问的问题如果智能体答不上来，或被点了「没用」，会出现在这里，可直接补充答案。</div>';

    // 绑定「补充答案」按钮
    $$('.add-faq').forEach((b) => {
      b.addEventListener('click', () => openFaqFromQuestion(b.dataset.q));
    });

    // 意图分布
    const intents = d.queries.intents;
    const max = intents.length ? intents[0].n : 1;
    const NAME = {
      retrieval: '知识检索', notices: '查通知', activities: '看活动',
      venues: '场所查询', repair: '报修指引', emergency: '紧急求助',
      fallback: '未命中', empty: '空输入',
    };
    $('#intentDist').innerHTML = intents.length
      ? intents.map((x) => `
        <div class="bar-row">
          <span class="bar-label">${escapeHTML(NAME[x.name] || x.name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.round(x.n / max * 100)}%"></span></span>
          <span class="bar-value">${x.n}</span>
        </div>`).join('')
      : '<div class="list-empty">暂无数据</div>';

    // 学生反馈
    const fb = d.feedback || { total: 0, helpful: 0, notHelpful: 0, satisfaction: null, topUnhelpful: [] };
    if (fb.total === 0) {
      $('#feedbackSummary').innerHTML =
        '<div class="list-empty">暂无反馈。<br>同学在回答下方点「👍 有用 / 👎 没用」后，这里会显示统计。</div>';
    } else {
      const sat = fb.satisfaction;
      const cls = sat === null ? '' : sat >= 80 ? 'good' : sat >= 60 ? 'mid' : 'bad';
      $('#feedbackSummary').innerHTML = `
        <div class="fb-stats">
          <div class="fb-stat">
            <span class="fb-num ${cls}">${sat === null ? '—' : sat + '%'}</span>
            <span class="fb-txt">满意度</span>
          </div>
          <div class="fb-stat">
            <span class="fb-num">${fb.total}</span>
            <span class="fb-txt">总反馈</span>
          </div>
          <div class="fb-stat">
            <span class="fb-num good">${fb.helpful}</span>
            <span class="fb-txt">👍 有用</span>
          </div>
          <div class="fb-stat">
            <span class="fb-num bad">${fb.notHelpful}</span>
            <span class="fb-txt">👎 没用</span>
          </div>
        </div>`;
    }

    $('#topUnhelpful').innerHTML = fb.topUnhelpful.length
      ? fb.topUnhelpful.map((x, i) => `
        <div class="list-row">
          <span class="rank">${i + 1}</span>
          <span class="qtext">
            ${escapeHTML(x.q)}
            ${x.head ? `<br><span style="color:var(--text-light);font-size:.92em">当时回答：${escapeHTML(x.head)}</span>` : ''}
          </span>
          <span class="qcount">${x.n} 次</span>
        </div>`).join('')
      : '<div class="list-empty">暂无被点「没用」的问题。</div>';

  } catch (err) {
    toast(err.message, true);
  }
}

$('#daysSelect').addEventListener('change', loadDashboard);
$('#btnRefresh').addEventListener('click', () => loadView(currentView));

/* ---------- 待确认 ---------- */

async function loadPending() {
  try {
    const d = await api('/api/teacher/dashboard?days=1');
    const badge = $('#pendingBadge');
    badge.textContent = d.pending.length;
    badge.classList.toggle('show', d.pending.length > 0);

    $('#pendingList').innerHTML = d.pending.length
      ? d.pending.map((p) => `
        <div class="item unverified">
          <div class="item-head">
            <div style="min-width:0">
              <div class="item-title">${escapeHTML(p.title)}</div>
              <div class="item-meta">
                <span class="tag warn">待确认</span>
                <span>${escapeHTML(KIND_META[p.kind] ? KIND_META[p.kind].title : p.kind)}</span>
                ${p.category ? `<span>${escapeHTML(p.category)}</span>` : ''}
                <span><code>${escapeHTML(p.id)}</code></span>
              </div>
            </div>
            <div class="item-actions">
              <button class="mini-btn verify" data-verify="${p.kind}:${p.id}">去核实</button>
            </div>
          </div>
        </div>`).join('')
      : '<div class="item"><div class="list-empty">🎉 没有待确认内容，知识库全部已核实。</div></div>';

    $$('[data-verify]').forEach((b) => {
      b.addEventListener('click', () => {
        const [kind, id] = b.dataset.verify.split(':');
        openEditor(kind, id);
      });
    });
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 内容管理 ---------- */

async function loadContent(kind) {
  try {
    const items = await api('/api/teacher/content/' + kind);
    const meta = KIND_META[kind];

    $('#contentList').innerHTML = items.length
      ? items.map((it) => renderItem(kind, it)).join('')
      : `<div class="item"><div class="list-empty">还没有内容，点击右上角「+ 新增」添加。</div></div>`;

    $$('[data-edit]').forEach((b) => {
      b.addEventListener('click', () => {
        const [k, id] = b.dataset.edit.split(':');
        openEditor(k, id);
      });
    });
    $$('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        const [k, id] = b.dataset.del.split(':');
        const title = b.dataset.title || id;
        if (!confirm(`确定删除「${title}」？此操作不可撤销。`)) return;
        try {
          await api(`/api/teacher/content/${k}/${id}`, { method: 'DELETE' });
          toast('已删除');
          loadContent(k);
        } catch (err) { toast(err.message, true); }
      });
    });
  } catch (err) {
    toast(err.message, true);
  }
}

function renderItem(kind, it) {
  const title = it.title || it.question || it.name;
  const verified = it.verified === true;
  const body = it.content || it.answer || it.detail || it.summary || it.note || '';

  const metas = [];
  if (it.category) metas.push(`<span class="tag plain">${escapeHTML(it.category)}</span>`);
  metas.push(verified
    ? `<span class="tag">已核实${it.sourceId ? ' · ' + escapeHTML(it.sourceId) : ''}</span>`
    : '<span class="tag warn">待确认</span>');
  if (it.date) metas.push(`<span>📅 ${escapeHTML(it.date)}</span>`);
  if (it.deadline) metas.push(`<span>⏰ ${escapeHTML(it.deadline)}</span>`);
  if (it.pinned) metas.push('<span class="tag hot">置顶</span>');
  if (it.status) metas.push(`<span class="tag plain">${escapeHTML(it.status)}</span>`);
  if (it.publisher) metas.push(`<span>${escapeHTML(it.publisher)}</span>`);
  if (it.location) metas.push(`<span>📍 ${escapeHTML(it.location)}</span>`);
  if (it.openHours) metas.push(`<span>🕐 ${escapeHTML(it.openHours)}</span>`);
  metas.push(`<span><code>${escapeHTML(it.id)}</code></span>`);

  return `
    <div class="item ${verified ? '' : 'unverified'}">
      <div class="item-head">
        <div style="min-width:0;flex:1">
          <div class="item-title">${escapeHTML(title)}</div>
          <div class="item-meta">${metas.join('')}</div>
          <div class="item-body">${escapeHTML(String(body).slice(0, 220))}</div>
        </div>
        <div class="item-actions">
          <button class="mini-btn" data-edit="${kind}:${it.id}">编辑</button>
          <button class="mini-btn danger" data-del="${kind}:${it.id}" data-title="${escapeHTML(title)}">删除</button>
        </div>
      </div>
    </div>`;
}

/* ---------- 编辑表单 ---------- */

const FIELDS = {
  notices: [
    { k: 'title', label: '标题', type: 'text', required: true },
    { k: 'category', label: '分类', type: 'text', hint: '如：社区公告 / 安全提醒 / 教务服务' },
    { k: 'publisher', label: '发布单位', type: 'text' },
    { k: 'date', label: '发布日期', type: 'date' },
    { k: 'deadline', label: '截止日期', type: 'date', hint: '留空表示无截止时间' },
    { k: 'content', label: '正文', type: 'textarea', required: true },
    { k: 'tags', label: '检索关键词', type: 'tags', hint: '用顿号或逗号分隔。同学可能用到的说法都放进来，能显著提升命中率' },
    { k: 'pinned', label: '置顶显示', type: 'bool' },
  ],
  activities: [
    { k: 'title', label: '活动名称', type: 'text', required: true },
    { k: 'category', label: '分类', type: 'text', hint: '如：志愿服务 / 讲座宣讲 / 文化活动' },
    { k: 'date', label: '活动日期', type: 'text', hint: '可填具体日期，未定则填「待定」' },
    { k: 'time', label: '活动时段', type: 'text', hint: '如：9:00—17:00' },
    { k: 'location', label: '地点', type: 'text' },
    { k: 'organizer', label: '主办单位', type: 'text' },
    { k: 'deadline', label: '报名截止', type: 'text' },
    { k: 'credit', label: '认定', type: 'text', hint: '如：志愿时长 / 第二课堂学分 / 无' },
    { k: 'status', label: '状态', type: 'select', options: ['报名中', '进行中', '预告', '已结束'] },
    { k: 'capacity', label: '名额', type: 'number' },
    { k: 'summary', label: '一句话简介', type: 'textarea' },
    { k: 'detail', label: '详细说明', type: 'textarea' },
    { k: 'tags', label: '检索关键词', type: 'tags', hint: '用顿号或逗号分隔' },
  ],
  faqs: [
    { k: 'question', label: '问题', type: 'text', required: true },
    { k: 'category', label: '分类', type: 'text', hint: '如：报修 / 心理 / 教务 / 资助' },
    { k: 'answer', label: '回答', type: 'textarea', required: true },
    { k: 'keywords', label: '检索关键词', type: 'tags', hint: '用顿号或逗号分隔。同学可能用到的说法都放进来' },
  ],
  venues: [
    { k: 'name', label: '场所名称', type: 'text', required: true },
    { k: 'location', label: '位置', type: 'text' },
    { k: 'openHours', label: '开放时间', type: 'text' },
    { k: 'capacity', label: '容量', type: 'text' },
    { k: 'booking', label: '预约方式', type: 'text' },
    { k: 'suitable', label: '适用场景', type: 'tags', hint: '用顿号或逗号分隔' },
    { k: 'facilities', label: '设施', type: 'tags', hint: '用顿号或逗号分隔' },
    { k: 'note', label: '备注', type: 'textarea' },
  ],
};

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  return String(v).split(/[、,，;；]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 从「未命中问题」直接创建 FAQ 草稿。
 *
 * 为什么要有这个：看板列出未命中问题，但如果只是"看得到"，
 * 老师还得手动切到 FAQ 页面、重新输入一遍问题——多这几步就足以让人放弃维护。
 * 这里把整条链路打通：点一下 → 问题已填好 → 只需写答案 → 保存 → 立即生效。
 *
 * 预填策略：
 *   · question：直接用同学的原始问法（这正是检索时匹配的文本）
 *   · keywords：从问题里自动抽出关键词，省得老师再想
 *   · answer：留空并给出填写提示，避免误存空答案
 *   · verified：默认「待确认」，逼老师核实后再标已核实
 */
async function openFaqFromQuestion(rawQuestion) {
  const q = String(rawQuestion || '').trim();
  if (!q) { toast('问题为空', true); return; }

  // 自动抽关键词：去掉疑问词与标点，剩下的词按常见切分给出
  const STOP = /怎么|如何|什么|哪些|哪个|多少|几点|在哪|哪里|可以|能不能|有没有|需要|应该|是不是|怎么办|怎样|一下|请问|我们|学校|学院|的时候|吗|呢|啊|吧/g;
  const cleaned = q.replace(STOP, ' ').replace(/[，。？！、,.?!；;：:\s]+/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);

  // 加上原问题整体，方便同学用完整句子也能命中
  const keywords = [...new Set([...words, q.replace(/[，。？！、,.?!；;：:]/g, '')])]
    .filter(Boolean)
    .slice(0, 8);

  editing = { kind: 'faqs', id: null, isNew: true };
  $('#editTitle').textContent = '从问题创建 FAQ';
  $('#editErrors').hidden = true;

  const fields = FIELDS.faqs;
  const draft = {
    question: q,
    category: '',
    answer: '',
    keywords,
    verified: false,
  };

  let html = `
    <div class="from-question">
      <span class="fq-label">来自未命中问题</span>
      <span class="fq-text">${escapeHTML(q)}</span>
      <span class="fq-hint">写下正确答案后保存，同学下次问同类问题就能得到回答了。</span>
    </div>`;

  for (const f of fields) {
    const val = draft[f.k] == null ? '' : draft[f.k];
    if (f.type === 'textarea') {
      html += `<div class="field">
        <label>${f.label}${f.required ? '<span class="req">*</span>' : ''}</label>
        <textarea data-field="${f.k}" ${f.required ? 'required' : ''}
          placeholder="${f.k === 'answer' ? '请填写准确答案。建议包含：办理流程、所需材料、办理地点、联系电话。' : ''}">${escapeHTML(val)}</textarea>
        ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
      </div>`;
    } else if (f.type === 'tags') {
      html += `<div class="field">
        <label>${f.label}</label>
        <input type="text" data-field="${f.k}" value="${escapeHTML(toArray(val).join('、'))}">
        ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
      </div>`;
    } else {
      html += `<div class="field">
        <label>${f.label}${f.required ? '<span class="req">*</span>' : ''}</label>
        <input type="text" data-field="${f.k}" value="${escapeHTML(val)}" ${f.required ? 'required' : ''}>
        ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
      </div>`;
    }
  }

  // 核实状态（与常规编辑器一致）
  html += `
    <div class="field">
      <label>核实状态<span class="req">*</span></label>
      <div class="radio-row">
        <label class="radio-opt">
          <input type="radio" name="f-verified" data-field="verified" value="true"> 已核实
        </label>
        <label class="radio-opt">
          <input type="radio" name="f-verified" data-field="verified" value="false" checked> 待确认
        </label>
      </div>
      <span class="hint">
        先按「待确认」保存也可以，学生端会显示待确认徽章；
        核实无误后再改为「已核实」并填写来源编号。
      </span>
    </div>
    <div class="field">
      <label>来源编号</label>
      <input type="text" data-field="sourceId" value="" placeholder="如 s008">
      <span class="hint">标为「已核实」时必填，取自「数据来源」页的编号。</span>
    </div>`;

  $('#editForm').innerHTML = html;
  $('#editModal').hidden = false;

  // 光标直接落在「回答」输入框，省一次点击
  const answerEl = $('#editForm').querySelector('[data-field="answer"]');
  if (answerEl) answerEl.focus();
}

async function openEditor(kind, id) {
  let data;
  try {
    const items = await api('/api/teacher/content/' + kind);
    data = id ? items.find((x) => x.id === id) : null;
    if (id && !data) { toast('未找到该条目', true); return; }
  } catch (err) {
    toast(err.message, true);
    return;
  }

  editing = { kind, id: id || null, isNew: !id };
  data = data || { verified: false };

  $('#editTitle').textContent = (id ? '编辑' : '新增') + KIND_META[kind].title.replace(/管理|公告/, '');
  $('#editErrors').hidden = true;

  const fields = FIELDS[kind];
  let html = '';

  for (const f of fields) {
    const val = data[f.k] == null ? '' : data[f.k];
    if (f.type === 'textarea') {
      html += `<div class="field">
        <label>${f.label}${f.required ? '<span class="req">*</span>' : ''}</label>
        <textarea data-field="${f.k}" ${f.required ? 'required' : ''}>${escapeHTML(val)}</textarea>
        ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
      </div>`;
    } else if (f.type === 'select') {
      html += `<div class="field">
        <label>${f.label}</label>
        <select data-field="${f.k}">
          ${f.options.map((o) => `<option value="${o}" ${val === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>`;
    } else if (f.type === 'bool') {
      html += `<div class="field">
        <label>${f.label}</label>
        <div class="radio-row">
          <label class="radio-opt"><input type="radio" name="f-${f.k}" data-field="${f.k}" value="true" ${val === true ? 'checked' : ''}> 是</label>
          <label class="radio-opt"><input type="radio" name="f-${f.k}" data-field="${f.k}" value="false" ${val !== true ? 'checked' : ''}> 否</label>
        </div>
      </div>`;
    } else if (f.type === 'tags') {
      html += `<div class="field">
        <label>${f.label}</label>
        <input type="text" data-field="${f.k}" value="${escapeHTML(toArray(val).join('、'))}">
        ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
      </div>`;
    } else {
      html += `<div class="field">
        <label>${f.label}${f.required ? '<span class="req">*</span>' : ''}</label>
        <input type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}"
               data-field="${f.k}" value="${escapeHTML(val)}" ${f.required ? 'required' : ''}>
        ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
      </div>`;
    }
  }

  // 核实状态（所有类型共用，且是硬性要求）
  html += `
    <div class="field">
      <label>核实状态<span class="req">*</span></label>
      <div class="radio-row">
        <label class="radio-opt">
          <input type="radio" name="f-verified" data-field="verified" value="true" ${data.verified === true ? 'checked' : ''}> 已核实
        </label>
        <label class="radio-opt">
          <input type="radio" name="f-verified" data-field="verified" value="false" ${data.verified !== true ? 'checked' : ''}> 待确认
        </label>
      </div>
      <span class="hint">
        「已核实」表示内容来自官方渠道，学生端显示来源；「待确认」会在学生端显示红色徽章。
        标为已核实必须填写下方来源编号。
      </span>
    </div>
    <div class="field">
      <label>来源编号</label>
      <input type="text" data-field="sourceId" value="${escapeHTML(data.sourceId || '')}"
             placeholder="如 s008">
      <span class="hint">
        取自「数据来源」页的编号。标为「已核实」时必填，标为「待确认」时留空。
      </span>
    </div>`;

  $('#editForm').innerHTML = html;
  $('#editModal').hidden = false;
  const first = $('#editForm').querySelector('input,textarea');
  if (first) first.focus();
}

function collectForm() {
  const out = {};
  const fields = FIELDS[editing.kind];

  for (const f of fields) {
    if (f.type === 'bool') {
      const checked = $(`input[name="f-${f.k}"]:checked`);
      out[f.k] = checked ? checked.value === 'true' : false;
    } else if (f.type === 'tags') {
      const el = $(`[data-field="${f.k}"]`);
      out[f.k] = toArray(el.value);
    } else if (f.type === 'number') {
      const el = $(`[data-field="${f.k}"]`);
      const n = parseInt(el.value, 10);
      out[f.k] = Number.isFinite(n) ? n : null;
    } else {
      const el = $(`[data-field="${f.k}"]`);
      out[f.k] = el.value.trim();
    }
  }

  // 核实状态
  const vEl = $('input[name="f-verified"]:checked');
  out.verified = vEl ? vEl.value === 'true' : false;
  const src = $('[data-field="sourceId"]').value.trim();
  out.sourceId = out.verified ? (src || null) : null;

  // 清理空值，保持数据文件整洁
  for (const k of Object.keys(out)) {
    if (out[k] === '' ) out[k] = null;
    if (Array.isArray(out[k]) && out[k].length === 0) out[k] = [];
  }

  return out;
}

$('#btnSave').addEventListener('click', async () => {
  if (!editing) return;
  const btn = $('#btnSave');
  btn.disabled = true;
  btn.textContent = '保存中…';
  $('#editErrors').hidden = true;

  try {
    const data = collectForm();
    if (editing.isNew) {
      await api('/api/teacher/content/' + editing.kind, {
        method: 'POST',
        body: JSON.stringify(data),
      });
      toast('已新增');
    } else {
      await api(`/api/teacher/content/${editing.kind}/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
      toast('已保存');
    }
    $('#editModal').hidden = true;
    editing = null;
    loadView(currentView === 'pending' ? 'pending' : currentKind);
  } catch (err) {
    const box = $('#editErrors');
    box.innerHTML = '<ul><li>' + escapeHTML(err.message).replace(/；/g, '</li><li>') + '</li></ul>';
    box.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
});

$('#btnNew').addEventListener('click', () => openEditor(currentKind, null));

$$('[data-close-edit]').forEach((el) => {
  el.addEventListener('click', () => { $('#editModal').hidden = true; editing = null; });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#editModal').hidden) {
    $('#editModal').hidden = true;
    editing = null;
  }
});

/* ---------- 数据来源 ---------- */

async function loadSources() {
  try {
    const d = await api('/api/teacher/sources');

    $('#sourceList').innerHTML = d.sources.length
      ? d.sources.map((s) => `
        <div class="item">
          <div class="item-head">
            <div style="min-width:0;flex:1">
              <div class="item-title">${escapeHTML(s.name)}</div>
              <div class="item-meta">
                <span class="tag">${escapeHTML(s.id)}</span>
                <a href="${escapeHTML(s.url)}" target="_blank" rel="noopener"
                   style="color:var(--hbuas-green);text-decoration:none">${escapeHTML(s.url)}</a>
              </div>
              <div class="item-body">用于：${escapeHTML((s.used || []).join('、'))}</div>
            </div>
          </div>
        </div>`).join('')
      : '<div class="item"><div class="list-empty">暂无来源</div></div>';

    $('#notVerifiedList').innerHTML = (d.notVerified || []).length
      ? d.notVerified.map((n) => `
        <div class="item unverified">
          <div class="item-head">
            <div style="min-width:0;flex:1">
              <div class="item-title">${escapeHTML(n.item)}</div>
              <div class="item-meta"><span class="tag warn">未核实</span></div>
              <div class="item-body">原因：${escapeHTML(n.reason)}
处理方式：${escapeHTML(n.handling)}</div>
            </div>
          </div>
        </div>`).join('')
      : '<div class="item"><div class="list-empty">无</div></div>';
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 初始化 ---------- */

(async function init() {
  if (!token) { $('#pinInput').focus(); return; }
  // 校验已保存的令牌是否仍然有效
  try {
    await api('/api/teacher/dashboard?days=1');
    enterConsole();
  } catch {
    logout(true);
  }
})();
