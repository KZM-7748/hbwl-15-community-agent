/* ============================================================
   会议工具页逻辑
   ============================================================ */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3200);
}

/** 组件 key → 中文名（用于提示与备选启动时的称呼） */
const launcher_names = {
  wps: 'WPS 文字',
  wpp: 'WPS 演示',
  et: 'WPS 表格',
};

/* ---------- 判断是否本机访问 ---------- */

/**
 * 唤起本机程序只在本机有效。
 * 用 hostname 判断：localhost / 127.0.0.1 视为本机；
 * 用局域网 IP 或域名访问的都是远程设备。
 */
function isLocalHost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/* ---------- 一、唤起 WPS ---------- */

function showLaunchStatus(msg, ok) {
  const el = $('#launchStatus');
  el.textContent = msg;
  el.className = 'launch-status ' + (ok ? 'ok' : 'fail');
  el.hidden = false;
}

/**
 * 通过 URL 协议唤起。
 *
 * 注意：浏览器的行为是「跳转」，如果系统没有处理该协议，
 * 页面不会有任何反应（也不会报错）——所以这里同时给出提示，
 * 让用户知道如果没反应该怎么办。
 */
function launchByProtocol(protocol, name) {
  showLaunchStatus(`正在唤起 ${name}…如果浏览器弹出确认框，请选择「允许」或「打开」。`, true);

  // 用隐藏 iframe 触发，避免当前页被导航走
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.appendChild(iframe);

  let settled = false;
  try {
    iframe.contentWindow.location.href = protocol;
  } catch {
    // 某些浏览器会抛异常，退回直接赋值
    try { location.href = protocol; } catch { /* ignore */ }
  }

  // 3 秒后如果页面还在（说明协议被拦截或没生效），给出提示
  setTimeout(() => {
    if (settled) return;
    settled = true;
    if (!document.hidden) {
      showLaunchStatus(
        `如果 ${name} 没有打开，可能是浏览器拦截了程序唤起。` +
        `请展开下方「点了没反应？」使用备选方式。`,
        false
      );
    }
    try { document.body.removeChild(iframe); } catch { /* ignore */ }
  }, 3000);
}

/**
 * 通过本机接口强制启动（备选方式）。
 *
 * 注意：这是**兜底**路径，正常情况下不会用到。
 * 浏览器点击 ksowps:// 时若被拦截（无反应、也不报错），
 * 才需要用到这个按钮。
 */
async function launchByApi(target, name) {
  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      const how = data.method === 'protocol' ? '系统协议' : '直接运行';
      showLaunchStatus(`${name} 已启动（方式：${how}）`, true);
    } else {
      showLaunchStatus(`启动失败：${data.error || '未知原因'}`, false);
    }
  } catch (e) {
    showLaunchStatus(`启动失败：${e.message}`, false);
  }
}

/* ---------- 二、会议模板 ---------- */

const TEMPLATES = {
  minutes: {
    name: '社区工作会议纪要',
    header: ['会议主题', ''],
    sections: [
      ['会议时间', ''],
      ['会议地点', ''],
      ['主持人', ''],
      ['记录人', ''],
      ['参会人员', ''],
      ['缺席人员', ''],
    ],
    body: [
      ['一、议题与讨论', ''],
      ['', ''],
      ['二、会议决议', ''],
      ['', ''],
      ['三、待办事项', ''],
      ['事项', '负责人', '完成时间'],
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
    ],
  },
  signin: {
    name: '活动签到表',
    header: ['序号', '姓名', '学号', '班级', '联系方式', '签到'],
    rows: 25,
  },
  plan: {
    name: '活动策划方案',
    header: ['活动名称', ''],
    sections: [
      ['主办单位', ''],
      ['活动时间', ''],
      ['活动地点', ''],
      ['参与对象', ''],
      ['预计人数', ''],
    ],
    body: [
      ['一、活动目的', ''],
      ['', ''],
      ['二、活动流程', ''],
      ['时间', '环节', '负责人'],
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
      ['三、人员分工', ''],
      ['姓名', '负责事项', '联系方式'],
      ['', '', ''],
      ['', '', ''],
      ['四、经费预算', ''],
      ['项目', '数量', '单价', '小计'],
      ['', '', '', ''],
      ['', '', '', ''],
      ['合计', '', '', ''],
    ],
  },
  duty: {
    name: '值班安排表',
    header: ['日期', '星期', '值班人', '联系方式', '备注'],
    rows: 14,
  },
};

/** CSV 转义：含逗号/引号/换行时加引号 */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(tpl) {
  const lines = [];
  if (tpl.header && tpl.sections === undefined && tpl.rows) {
    // 表格式（签到表、值班表）
    lines.push(tpl.header.map(csvCell).join(','));
    for (let i = 1; i <= tpl.rows; i++) {
      const row = tpl.header.map((_, idx) => (idx === 0 ? i : ''));
      lines.push(row.map(csvCell).join(','));
    }
    return lines.join('\r\n');
  }

  // 文档式（纪要、方案）
  if (tpl.header) lines.push(tpl.header.map(csvCell).join(','));
  for (const s of tpl.sections || []) lines.push(s.map(csvCell).join(','));
  if (tpl.body && tpl.body.length) {
    lines.push('');
    for (const r of tpl.body) lines.push(r.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

/**
 * 生成并下载 CSV。
 *
 * 加 UTF-8 BOM：不加的话 WPS/Excel 打开中文会乱码（它们默认按 GBK 解析）。
 * 这是 Windows 上 CSV 中文乱码最常见的原因。
 */
function downloadCsv(filename, csv) {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadTemplate(key) {
  const tpl = TEMPLATES[key];
  if (!tpl) { toast('未知模板', true); return; }
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  downloadCsv(`${tpl.name}-${stamp}.csv`, buildCsv(tpl));
  toast(`已下载：${tpl.name}`);
}

/* ---------- 三、导出知识库 ---------- */

async function exportKnowledge(kind) {
  const MAP = {
    notices: { url: '/api/notices', name: '社区通知', cols: ['标题', '分类', '发布日期', '截止日期', '发布单位', '正文'] },
    activities: { url: '/api/activities', name: '社区活动', cols: ['名称', '分类', '日期', '时间', '地点', '主办', '状态', '报名截止', '认定', '简介'] },
    faqs: { url: '/api/teacher/content/faqs', name: '常见问题', cols: ['问题', '分类', '回答'] },
    venues: { url: '/api/venues', name: '服务场所', cols: ['名称', '位置', '开放时间', '预约方式', '备注'] },
  };
  const m = MAP[kind];
  if (!m) { toast('未知类型', true); return; }

  try {
    // faqs 需要教师端鉴权，未登录时退回用公开接口拿问题列表
    let items;
    const res = await fetch(m.url);
    if (res.status === 401) {
      toast('导出常见问题需要先在教师端登录', true);
      return;
    }
    items = await res.json();
    if (!Array.isArray(items)) { toast('数据格式异常', true); return; }

    const lines = [m.cols.map(csvCell).join(',')];
    for (const it of items) {
      let row;
      if (kind === 'notices') {
        row = [it.title, it.category, it.date, it.deadline, it.publisher, it.content];
      } else if (kind === 'activities') {
        row = [it.title, it.category, it.date, it.time, it.location, it.organizer, it.status, it.deadline, it.credit, it.summary];
      } else if (kind === 'faqs') {
        row = [it.question, it.category, it.answer];
      } else {
        row = [it.name, it.location, it.openHours, it.booking, it.note];
      }
      lines.push(row.map(csvCell).join(','));
    }

    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    downloadCsv(`${m.name}-${stamp}.csv`, lines.join('\r\n'));
    toast(`已导出 ${items.length} 条${m.name}`);
  } catch (e) {
    toast('导出失败：' + e.message, true);
  }
}

/* ---------- 初始化 ---------- */

(function init() {
  const local = isLocalHost();

  // 远程访问：提示并禁用唤起
  if (!local) {
    $('#remoteNotice').hidden = false;
    $$('.launch-btn').forEach((b) => { b.disabled = true; });
    $('#btnForceLaunch').disabled = true;
    $('#fallbackHint').textContent = '远程访问时不可用。';
  }

  // 检测本机 WPS 是否安装
  if (local) {
    fetch('/api/wps/detect')
      .then((r) => r.json())
      .then((d) => {
        if (!d.available) {
          showLaunchStatus(
            '未在本机检测到 WPS Office。请先安装 WPS，或确认安装路径。',
            false
          );
          return;
        }
        // 只启用检测到的组件
        const found = new Set(d.targets.map((t) => t.key));
        $$('.launch-btn').forEach((b) => {
          if (!found.has(b.dataset.target)) {
            b.disabled = true;
            b.querySelector('.lb-desc').textContent = '未检测到该组件';
          }
        });
        $('#fallbackHint').textContent =
          `已检测到：${d.targets.map((t) => t.name).join('、')}`;
      })
      .catch(() => {
        // 检测失败不阻断，仍允许尝试协议唤起
      });
  }

  // 唤起按钮
  //
  // 同时保存「用户点的是哪个」，让备选方式（强制启动）能启动同一组件。
  // 早期版本强制启动固定只开 wps，点「WPS 表格」后强制启动也开的是文字。
  let lastTarget = null;

  $$('.launch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      lastTarget = target;
      const protocol = btn.dataset.protocol;
      const name = btn.querySelector('.lb-name').textContent;
      launchByProtocol(protocol, name);
    });
  });

  // 强制启动：启动用户**刚才点的那个**组件（默认文字）
  const forceBtn = $('#btnForceLaunch');
  forceBtn.addEventListener('click', () => {
    const target = lastTarget || 'wps';
    const name = launcher_names[target] || 'WPS 文字';
    launchByApi(target, name);
  });

  // 让按钮文案跟随当前选择，避免误解
  $$('.launch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = launcher_names[btn.dataset.target] || 'WPS 文字';
      forceBtn.textContent = `强制启动 ${name}`;
    });
  });

  // 模板下载
  $$('[data-tpl]').forEach((b) => {
    b.addEventListener('click', () => downloadTemplate(b.dataset.tpl));
  });

  // 导出知识库
  $$('[data-export]').forEach((b) => {
    b.addEventListener('click', () => exportKnowledge(b.dataset.export));
  });
})();
