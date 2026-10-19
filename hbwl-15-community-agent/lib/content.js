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

/** 问答日志保留天数（超出自动清理，避免无限增长） */
const LOG_RETAIN_DAYS = 90;

const FILES = {
  notices: 'notices.json',
  faqs: 'faq.json',
  activities: 'activities.json',
  venues: 'venues.json',
};

/**
 * 本地日期 YYYY-MM-DD。
 * 不能用 toISOString()——那是 UTC，东八区凌晨会得到「昨天」，导致日志文件按错误的日期命名。
 */
function todayLocal(d = new Date()) {
  return `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`;
}

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

  /**
   * 校验一条内容，返回错误信息数组
   *
   * 注意：四类内容的必填字段不同，必须分开判断。
   * 早期版本把 notices 与 activities 合在一个 else 分支里，都要求 content，
   * 而活动实际用的是 summary / detail —— 结果教师端**无法发布任何活动**。
   */
  validate(kind, item, { requireId = false } = {}) {
    const errs = [];
    const filled = (v) => v != null && String(v).trim() !== '';

    if (requireId && !item.id) errs.push('缺少 id');

    if (kind === 'faqs') {
      if (!filled(item.question)) errs.push('缺少 question（问题）');
      if (!filled(item.answer)) errs.push('缺少 answer（回答）');
    } else if (kind === 'venues') {
      if (!filled(item.name)) errs.push('缺少 name（场所名称）');
    } else if (kind === 'activities') {
      if (!filled(item.title)) errs.push('缺少 title（活动名称）');
      // 活动正文允许用 summary 或 detail 任一（与数据文件的实际字段一致）
      if (!filled(item.summary) && !filled(item.detail)) {
        errs.push('缺少 summary 或 detail（活动简介 / 详细说明）');
      }
    } else {
      // notices
      if (!filled(item.title)) errs.push('缺少 title（标题）');
      if (!filled(item.content)) errs.push('缺少 content（正文）');
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

  /**
   * 记录一次问答（用于统计高频问题）
   *
   * 同时做日志轮转：只保留最近 LOG_RETAIN_DAYS 天的文件。
   * 不轮转的话，日志会无限增长——按一天 500 条算，
   * 三年就是 50 万条、46 MB，看板聚合要 0.5 秒（实测见 benchmark.js）。
   */
  logQuery(question, intent, verified, lowConfidence) {
    try {
      ensureDirs();
      const day = todayLocal();
      const file = path.join(LOG_DIR, `queries-${day}.jsonl`);
      const rec = JSON.stringify({
        t: Date.now(),
        q: String(question).slice(0, 200),
        intent,
        verified: verified !== false,
        // 低置信度：系统给了回答，但可能答非所问（见 agent.js 的阈值说明）
        low: lowConfidence === true,
      });
      fs.appendFileSync(file, rec + '\n', 'utf8');

      // 每天最多清理一次，避免每次写日志都扫目录
      if (this._lastRotate !== day) {
        this._lastRotate = day;
        this.rotateLogs();
      }
    } catch {
      // 日志失败不影响问答
    }
  }

  /**
   * 清理过期日志文件。保留最近 LOG_RETAIN_DAYS 天。
   * @returns {number} 删除的文件数
   */
  rotateLogs(retainDays = LOG_RETAIN_DAYS) {
    ensureDirs();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retainDays);
    const cutoffStr = `${cutoff.getFullYear()}-` +
      `${String(cutoff.getMonth() + 1).padStart(2, '0')}-` +
      `${String(cutoff.getDate()).padStart(2, '0')}`;

    let removed = 0;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = f.match(/^queries-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      if (m[1] < cutoffStr) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); removed++; } catch { /* ignore */ }
      }
    }
    return removed;
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
   * 记录学生对某条回答的反馈（有用 / 没用）。
   *
   * 为什么需要：看板目前只知道「哪些问题没答上」，
   * 不知道「哪些问题答了但答得不对」。后者更隐蔽——
   * 同学看到一段不相关的内容，可能就默默走了，不会换个说法再问。
   *
   * @param {object} p
   * @param {string} p.question 原问题
   * @param {boolean} p.helpful 是否有用
   * @param {string} [p.intent] 当时的意图
   * @param {string} [p.answerHead] 回答开头，便于教师定位是哪条内容
   */
  logFeedback({ question, helpful, intent, answerHead }) {
    try {
      ensureDirs();
      const day = todayLocal();
      const file = path.join(LOG_DIR, `feedback-${day}.jsonl`);
      fs.appendFileSync(file, JSON.stringify({
        t: Date.now(),
        q: String(question || '').slice(0, 200),
        helpful: !!helpful,
        intent: intent || '',
        head: String(answerHead || '').slice(0, 80),
      }) + '\n', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 读取反馈记录 */
  readFeedback(days = 30) {
    ensureDirs();
    const out = [];
    const now = Date.now();
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = f.match(/^feedback-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const age = (now - new Date(m[1] + 'T00:00:00Z').getTime()) / 86400000;
      if (age > days) continue;
      for (const ln of fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')) {
        if (!ln.trim()) continue;
        try { out.push(JSON.parse(ln)); } catch { /* ignore */ }
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

    // 学生反馈记录（待补充清单与满意度统计都要用）
    const feedback = this.readFeedback(days);

    // ---- 待补充清单 ----
    //
    // 把两种「需要老师补充内容」的情况合并成一个列表：
    //   1. 未命中：智能体答不上来（intent=fallback）
    //   2. 被点「没用」：答了，但同学认为不对
    //
    // 第 2 类更隐蔽也更有价值。实测过一个例子：
    //   「校园网密码忘了怎么重置」命中了「校园网与信息化服务入口」这条通知
    //   （讲的是入口网址），得分 10.26，系统认为答上了；
    //   但那条根本没讲密码怎么重置 —— 同学的问题实际没解决。
    //   如果只看 fallback，这类缺口永远进不了待补充清单。
    //
    // 合并后按「缺口强度」排序：被点没用权重更高（说明答了但答错），
    // 未命中次之（说明没答）。
    const gapMap = new Map();

    for (const l of logs) {
      if (l.intent !== 'fallback') continue;
      const key = String(l.q || '').trim();
      if (!key) continue;
      const cur = gapMap.get(key) || { q: key, missed: 0, unhelpful: 0, low: 0, head: '', intents: new Set() };
      cur.missed++;
      cur.intents.add('fallback');
      gapMap.set(key, cur);
    }

    // 低置信度：系统给了回答但可能答非所问（如「校车几点发车」答成「宿舍几点熄灯」）
    for (const l of logs) {
      if (!l.low) continue;
      const key = String(l.q || '').trim();
      if (!key) continue;
      const cur = gapMap.get(key) || { q: key, missed: 0, unhelpful: 0, low: 0, head: '', intents: new Set() };
      cur.low++;
      if (l.intent) cur.intents.add(l.intent);
      gapMap.set(key, cur);
    }

    for (const fb of feedback) {
      if (fb.helpful) continue;
      const key = String(fb.q || '').trim();
      if (!key) continue;
      const cur = gapMap.get(key) || { q: key, missed: 0, unhelpful: 0, low: 0, head: '', intents: new Set() };
      cur.unhelpful++;
      if (!cur.head && fb.head) cur.head = fb.head;
      if (fb.intent) cur.intents.add(fb.intent);
      gapMap.set(key, cur);
    }

    // 按权重排序：被点「没用」3 分（答了但错），低置信度 2 分（可能答错），未命中 1 分（没答）
    const pendingAnswers = [...gapMap.values()]
      .map((x) => ({
        q: x.q,
        missed: x.missed,
        unhelpful: x.unhelpful,
        low: x.low,
        score: x.unhelpful * 3 + x.low * 2 + x.missed,
        head: x.head,
        intents: [...x.intents],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    // 保留原有的 topMissed（仅未命中），兼容旧逻辑与既有测试
    const topMissed = pendingAnswers
      .filter((x) => x.missed > 0)
      .map((x) => ({ q: x.q, n: x.missed }))
      .slice(0, 10);

    // 意图分布
    const intents = new Map();
    for (const l of logs) {
      intents.set(l.intent, (intents.get(l.intent) || 0) + 1);
    }

    // 学生反馈统计
    let helpful = 0;
    let notHelpful = 0;
    for (const fb of feedback) {
      if (fb.helpful) helpful++; else notHelpful++;
    }
    const topUnhelpful = pendingAnswers
      .filter((x) => x.unhelpful > 0)
      .map((x) => ({ q: x.q, n: x.unhelpful, head: x.head, intent: x.intents[0] || '' }))
      .slice(0, 10);

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
      // 待补充清单：未命中 + 被点「没用」，合并后按缺口强度排序
      pendingAnswers,
      feedback: {
        days,
        total: feedback.length,
        helpful,
        notHelpful,
        // 满意度：仅有反馈时计算，无反馈返回 null
        satisfaction: feedback.length ? Math.round((helpful / feedback.length) * 100) : null,
        topUnhelpful,
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

module.exports = { ContentManager, DATA_DIR, LOG_DIR, FILES, LOG_RETAIN_DAYS };
