'use strict';

/**
 * 内容管理（教师端）
 *
 * 职责：
 *   1. 承载教师端对知识库的增删改（通知 / 活动 / FAQ）
 *   2. 把改动写入 data/ 下的 JSON 文件，并做原子写入
 *   3. 维护"待确认 → 已核实"的审核流转
 *   4. 记录问答日志，供数据看板统计高频问题
 *
 * 设计取舍：
 *   - 不做数据库：知识库是几十条量级，JSON 文件足够，且便于学院直接用文本编辑器维护
 *   - 写入前先校验：verified:true 必须有有效 sourceId，与自检脚本同一套规则
 *   - 原子写入：先写临时文件再 rename，避免写入中断损坏知识库
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(__dirname, '..', 'data', '_logs');

const FILES = {
  notices: 'notices.json',
  faqs: 'faq.json',
  activities: 'activities.json',
  venues: 'venues.json',
};

function ensureDirs() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

/** 原子写入：先写临时文件，再重命名覆盖 */
function writeJSONAtomic(name, data) {
  const target = path.join(DATA_DIR, name);
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

/** 生成下一个 id，如 n009 / f027 / a008 / v007 */
function nextId(items, prefix) {
  let max = 0;
  for (const it of items) {
    const m = String(it.id || '').match(new RegExp('^' + prefix + '(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + String(max + 1).padStart(3, '0');
}

class ContentManager {
  constructor() {
    ensureDirs();
    this.validSourceIds = new Set(
      (readJSON('sources.json').sources || []).map((s) => s.id)
    );
  }

  /** 校验一条内容，返回错误信息数组 */
  validate(kind, item, { requireId = false } = {}) {
    const errs = [];
    if (requireId && !item.id) errs.push('缺少 id');

    if (kind === 'faqs') {
      if (!item.question || !String(item.question).trim()) errs.push('缺少 question（问题）');
      if (!item.answer || !String(item.answer).trim()) errs.push('缺少 answer（回答）');
    } else if (kind === 'venues') {
      if (!item.name || !String(item.name).trim()) errs.push('缺少 name（场所名称）');
    } else {
      if (!item.title || !String(item.title).trim()) errs.push('缺少 title（标题）');
      if (!item.content || !String(item.content).trim()) errs.push('缺少 content（正文）');
    }

    // 与自检脚本同一套溯源规则
    if (item.verified === true) {
      if (!item.sourceId) errs.push('标为「已核实」必须填写 sourceId（来源编号）');
      else if (!this.validSourceIds.has(item.sourceId)) {
        errs.push(`sourceId「${item.sourceId}」不存在于 sources.json`);
      }
    } else if (item.verified === false) {
      if (item.sourceId) errs.push('标为「待确认」不应填写 sourceId');
    } else {
      errs.push('缺少 verified 字段（true=已核实 / false=待确认）');
    }

    return errs;
  }

  /** 读取某类内容 */
  list(kind) {
    const file = FILES[kind];
    if (!file) throw new Error('未知的内容类型：' + kind);
    return readJSON(file);
  }

  /** 新增一条 */
  create(kind, item) {
    const file = FILES[kind];
    if (!file) throw new Error('未知的内容类型：' + kind);

    const items = readJSON(file);
    const prefix = { notices: 'n', faqs: 'f', activities: 'a', venues: 'v' }[kind];
    const record = { ...item, id: item.id || nextId(items, prefix) };

    const errs = this.validate(kind, record);
    if (errs.length) return { ok: false, errors: errs };
    if (items.some((x) => x.id === record.id)) {
      return { ok: false, errors: [`id「${record.id}」已存在`] };
    }

    items.push(record);
    writeJSONAtomic(file, items);
    return { ok: true, item: record };
  }

  /** 修改一条 */
  update(kind, id, patch) {
    const file = FILES[kind];
    if (!file) throw new Error('未知的内容类型：' + kind);

    const items = readJSON(file);
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, errors: [`未找到 ${id}`] };

    const merged = { ...items[idx], ...patch, id };   // id 不可改
    const errs = this.validate(kind, merged, { requireId: true });
    if (errs.length) return { ok: false, errors: errs };

    items[idx] = merged;
    writeJSONAtomic(file, items);
    return { ok: true, item: merged };
  }

  /** 删除一条 */
  remove(kind, id) {
    const file = FILES[kind];
    if (!file) throw new Error('未知的内容类型：' + kind);

    const items = readJSON(file);
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, errors: [`未找到 ${id}`] };

    const [removed] = items.splice(idx, 1);
    writeJSONAtomic(file, items);
    return { ok: true, item: removed };
  }

  /** 待确认清单：教师端首页的待办 */
  pending() {
    const out = [];
    for (const [kind, file] of Object.entries(FILES)) {
      for (const item of readJSON(file)) {
        if (item.verified === false) {
          out.push({
            kind,
            id: item.id,
            title: item.title || item.question || item.name,
            category: item.category || '',
          });
        }
      }
    }
    return out;
  }

  /** 数据来源清单（供教师端查看） */
  sources() {
    const s = readJSON('sources.json');
    return {
      updatedAt: s.updatedAt,
      sources: s.sources || [],
      notVerified: s.notVerified || [],
    };
  }

  // ---------- 问答日志与看板 ----------

  /** 记录一次问答（用于统计高频问题） */
  logQuery(question, intent, verified) {
    try {
      ensureDirs();
      const day = new Date().toISOString().slice(0, 10);
      const file = path.join(LOG_DIR, `queries-${day}.jsonl`);
      const rec = JSON.stringify({
        t: Date.now(),
        q: String(question).slice(0, 200),
        intent,
        verified: verified !== false,
      });
      fs.appendFileSync(file, rec + '\n', 'utf8');
    } catch {
      // 日志失败不影响问答
    }
  }

  /** 读取最近 N 天的问答日志 */
  readLogs(days = 7) {
    ensureDirs();
    const out = [];
    const now = Date.now();
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = f.match(/^queries-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const age = (now - new Date(m[1] + 'T00:00:00Z').getTime()) / 86400000;
      if (age > days) continue;
      const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n');
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { out.push(JSON.parse(ln)); } catch { /* 跳过损坏行 */ }
      }
    }
    return out;
  }

  /**
   * 数据看板。
   * 教师最关心的三类信息：知识库健康度、待办事项、同学都在问什么。
   */
  dashboard(days = 7) {
    const counts = {};
    let verified = 0;
    let unverified = 0;

    for (const [kind, file] of Object.entries(FILES)) {
      const items = readJSON(file);
      counts[kind] = items.length;
      for (const it of items) {
        if (it.verified === true) verified++;
        else if (it.verified === false) unverified++;
      }
    }

    const logs = this.readLogs(days);

    // 高频问题 Top 10（按原文归并，便于教师识别学生真实表达）
    const freq = new Map();
    for (const l of logs) {
      const key = String(l.q || '').trim();
      if (!key) continue;
      freq.set(key, (freq.get(key) || 0) + 1);
    }
    const topQuestions = [...freq.entries()]
      .map(([q, n]) => ({ q, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 10);

    // 未命中问题：这些是知识库缺口，最有维护价值
    const missed = new Map();
    for (const l of logs) {
      if (l.intent === 'fallback') {
        const key = String(l.q || '').trim();
        if (!key) continue;
        missed.set(key, (missed.get(key) || 0) + 1);
      }
    }
    const topMissed = [...missed.entries()]
      .map(([q, n]) => ({ q, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 10);

    // 意图分布
    const intents = new Map();
    for (const l of logs) {
      intents.set(l.intent, (intents.get(l.intent) || 0) + 1);
    }

    return {
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      verified,
      unverified,
      pending: this.pending(),
      queries: {
        days,
        total: logs.length,
        topQuestions,
        topMissed,
        intents: [...intents.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
      },
      sourceCount: this.validSourceIds.size,
    };
  }

  /** 清空问答日志（教师端维护操作） */
  clearLogs() {
    ensureDirs();
    let n = 0;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (/^queries-.*\.jsonl$/.test(f)) {
        fs.unlinkSync(path.join(LOG_DIR, f));
        n++;
      }
    }
    return n;
  }
}

module.exports = { ContentManager, DATA_DIR, LOG_DIR, FILES };
