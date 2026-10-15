'use strict';

/**
 * 中文检索引擎 —— 零依赖
 *
 * 设计要点：
 * 1. 中文没有空格分词，采用「字符二元组（bigram）+ 关键词」混合切分
 * 2. BM25 排序，对短文本（FAQ 问句）表现稳定
 * 3. 额外加权：标题/关键词命中、分类命中、精确短语命中
 *
 * 之所以不用向量模型：社区一体机可能无外网、无 GPU，
 * 且交付后需长期免维护，规则检索在此场景下更可靠、可解释。
 */

// 中文停用词（高频但无区分度）
const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '怎么', '什么', '可以', '吗', '呢', '啊', '吧', '请问', '一下',
  '哪个', '哪些', '如何', '为什么', '多少', '有没有', '需要', '应该', '能不能',
]);

const isCJK = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf);
};

/**
 * 单个汉字 token 的权重系数。
 *
 * 单字区分度极低（「怎」「么」「样」能匹配到任意含「会怎样」的句子），
 * 若与二元组同权，会把「今天天气怎么样」这类无关问题误判成命中。
 * 因此单字仅作辅助召回信号，权重压到二元组的 1/4。
 */
const UNIGRAM_WEIGHT = 0.25;

/** 是否为「单个汉字」token */
const isUnigramCJK = (t) => t.length === 1 && isCJK(t);

/** 计算某 token 在索引/查询中的权重系数 */
const tokenWeight = (t) => (isUnigramCJK(t) ? UNIGRAM_WEIGHT : 1);

/**
 * 把一段文本切成检索单元。
 * - 中文：单字（低权重）+ 相邻二元组（主要信号）
 * - 英文/数字：整词
 */
function tokenize(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const tokens = [];
  let latin = '';

  const flushLatin = () => {
    if (latin.length >= 2) tokens.push(latin);
    latin = '';
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (isCJK(ch)) {
      flushLatin();
      if (!STOPWORDS.has(ch)) tokens.push(ch);
      const next = s[i + 1];
      if (next && isCJK(next)) {
        const bigram = ch + next;
        if (!STOPWORDS.has(bigram)) tokens.push(bigram);
      }
    } else if (/[a-z0-9]/.test(ch)) {
      latin += ch;
    } else {
      flushLatin();
    }
  }
  flushLatin();
  return tokens;
}

/** 文档 = 一条知识（通知 / FAQ / 活动 / 场地） */
function buildDocument(item, opts = {}) {
  const weight = opts.weight || 1;
  // 参与索引的字段：问题/标题权重高，正文权重低
  const fields = [
    { text: item.title || item.question || item.name || '', boost: 3.0 },
    { text: (item.keywords || []).join(' '), boost: 2.5 },
    { text: (item.tags || []).join(' '), boost: 2.0 },
    { text: item.category || '', boost: 1.5 },
    { text: item.summary || '', boost: 1.2 },
    { text: item.content || item.answer || item.detail || '', boost: 1.0 },
    { text: item.location || '', boost: 1.0 },
    { text: (item.facilities || []).join(' '), boost: 1.0 },
    { text: (item.suitable || []).join(' '), boost: 1.0 },
  ];

  const tf = new Map();
  let length = 0;
  for (const f of fields) {
    if (!f.text) continue;
    const toks = tokenize(f.text);
    length += toks.length;
    for (const t of toks) {
      // 单字降权：抑制「怎/么/样」这类无区分度匹配
      tf.set(t, (tf.get(t) || 0) + f.boost * weight * tokenWeight(t));
    }
  }
  return { tf, length: Math.max(length, 1), raw: item };
}

/** BM25 索引 */
class SearchIndex {
  constructor() {
    this.docs = [];
    this.df = new Map();       // 词 -> 出现文档数
    this.avgLength = 0;
    this.k1 = 1.5;
    this.b = 0.6;              // 短文本场景下 b 取小值，降低长度惩罚
  }

  add(item, opts) {
    const doc = buildDocument(item, opts);
    doc.id = this.docs.length;
    this.docs.push(doc);
    for (const t of doc.tf.keys()) {
      this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    return doc;
  }

  finalize() {
    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length ? total / this.docs.length : 1;
  }

  /** 返回 [{ doc, score }]，按分数降序 */
  search(query, limit = 5) {
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];

    const qSet = new Set(qTokens);
    const N = this.docs.length;
    const scores = new Float64Array(N);

    // 查询侧同样按 token 权重缩放，保证与索引侧一致
    let meaningful = 0;   // 二元组/英文词数量——真正有区分度的信号
    for (const t of qSet) if (!isUnigramCJK(t)) meaningful++;

    for (const term of qSet) {
      const df = this.df.get(term) || 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const qw = tokenWeight(term);
      for (const doc of this.docs) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const norm = 1 - this.b + this.b * (doc.length / this.avgLength);
        scores[doc.id] += qw * idf * ((f * (this.k1 + 1)) / (f + this.k1 * norm));
      }
    }

    // 只靠单字拼出来的匹配不可信：把分数整体压到阈值以下
    if (meaningful === 0) {
      for (let i = 0; i < N; i++) scores[i] *= 0.15;
    }

    // 精确短语加成：整串问题命中标题/关键词时明显提权
    const rawQ = String(query).trim().toLowerCase();
    if (rawQ.length >= 4) {
      for (const doc of this.docs) {
        const hay = [
          doc.raw.title, doc.raw.question, doc.raw.name,
          (doc.raw.keywords || []).join(' '), (doc.raw.tags || []).join(' '),
        ].filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(rawQ)) scores[doc.id] += 8;
      }
    }

    const out = [];
    for (let i = 0; i < N; i++) {
      if (scores[i] > 0) out.push({ doc: this.docs[i], score: scores[i] });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }
}

module.exports = { SearchIndex, tokenize, buildDocument, isCJK, isUnigramCJK, tokenWeight, STOPWORDS };
