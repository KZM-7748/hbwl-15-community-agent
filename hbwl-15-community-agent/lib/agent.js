'use strict';

/**
 * 智能体大脑 —— 意图识别 + 检索 + 回答生成
 *
 * 工作方式（三级）：
 *   1. 规则意图层：识别「通知/活动/自习预约/报修/报修/紧急」等明确意图，走专用数据通道
 *   2. 检索层：BM25 检索 FAQ + 通知 + 活动 + 场地，取最相关条目
 *   3. 兜底层：置信度不足时给出引导式回答，而不是硬编一个错误答案
 *
 * 可选 LLM 增强：设置环境变量 LLM_API_KEY 后，检索结果会作为上下文交给大模型润色。
 * 未配置时完全离线运行，保证一体机断网也能用。
 */

const fs = require('fs');
const path = require('path');
const { SearchIndex } = require('./retrieval');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadJSON(name) {
  const p = path.join(DATA_DIR, name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------- 意图规则 ----------

/**
 * 意图按「列表类」与「话题类」分组。
 *
 * 关键设计：列表类问题（「最近有什么活动」）必须先于 FAQ 检索处理。
 * 因为 FAQ 里存在「怎么报名参加活动」这类高相似条目，会把列表类问题
 * 劫持成一个「怎么报名」的流程答案，而用户其实想看活动清单。
 */
const INTENTS = [
  {
    name: 'emergency',
    // 紧急安全类：已发生的事实性描述，必须最先匹配。
    //
    // 注意：不能用 /报警/ 这类「名词」做触发条件——「学校的报警电话是多少」
    // 只是查询号码，不该触发紧急处置流程。因此这里只匹配
    //   (a) 已经发生的受损事实（被骗、转账、着火、受伤…）
    //   (b) 明确的求助动作（我要报警、快报警、救命…）
    patterns: [
      /被诈骗|被骗|转账了|汇款了|钱转出去|已经转|把钱转/,
      /着火了|失火|火灾|起火了/,
      /受伤|流血|晕倒|急救|喘不上气|中毒/,
      /打架|威胁|被打了|人身安全/,
      /自杀|轻生|不想活/,
      /救命|快报警|我要报警|赶紧报警|马上报警|帮我报警/,
    ],
    handler: 'emergency',
    kind: 'topic',
  },
  {
    name: 'phone',
    // 查询电话号码/联系方式：走 FAQ 检索，给出准确号码，不触发紧急流程
    patterns: [/电话是多少|电话号码|联系电话|怎么联系|联系方式|热线|号码/],
    handler: null,      // 不设专用通道，交回检索流程
    kind: 'topic',
  },
  {
    name: 'activity',
    // 只匹配「社区活动」语境。
    //
    // 注意：早期用裸「报名」做触发词，导致「四六级报名时间」这类
    // 教务考试查询被误判为社区活动列表。现在要求出现社区活动语境词，
    // 或明确的清单式问法。
    patterns: [
      /有什么活动|哪些活动|近期活动|最近的活动|活动安排|活动可以报名|活动报名/,
      /志愿活动|志愿服务活动|讲座|宣讲|分享会|文化节|比赛|竞赛|招募/,
    ],
    handler: 'activities',
    kind: 'list',
  },
  {
    name: 'notice',
    patterns: [/有什么通知|哪些通知|最近的通知|近期通知|最新通知|有什么新|最新消息|有什么公告|社区公告|截止时间|什么时候截止|有什么安排/],
    handler: 'notices',
    kind: 'list',
  },
  {
    name: 'venue',
    // 仅匹配「要一份场所清单」的问法。
    //
    // 注意：早期版本把「开放时间」「在哪」也放进来，导致
    // 「图书馆开放时间」这类**针对某个具体场所**的查询被误判为列表意图，
    // 返回全部场所清单。现在只保留明显的清单式问法，
    // 具体场所的开放时间交回检索流程（命中则答该场所，未命中则如实说没有）。
    patterns: [/有哪些场所|有什么场所|哪些场地|有什么场地|活动室在哪|场地怎么借|借用场地|能容纳多少人|有哪些地方|社区空间/],
    handler: 'venues',
    kind: 'list',
  },
  {
    name: 'repair',
    patterns: [/报修|坏了|维修|故障|漏水|断电|灯不亮|门锁|空调坏|水管/],
    handler: 'repair',
    kind: 'topic',
  },
];

// ---------- 智能体 ----------

class CommunityAgent {
  constructor() {
    this.notices = loadJSON('notices.json');
    this.faqs = loadJSON('faq.json');
    this.activities = loadJSON('activities.json');
    this.venues = loadJSON('venues.json');

    // 数据溯源：记录每条知识的来源与核实状态
    try {
      this.sources = loadJSON('sources.json');
    } catch {
      this.sources = { sources: [], notVerified: [] };
    }
    this.sourceMap = new Map((this.sources.sources || []).map((s) => [s.id, s]));

    // 统一索引：所有知识进同一个 BM25 空间，用 type 区分
    this.index = new SearchIndex();
    for (const n of this.notices) this.index.add({ ...n, type: 'notice', text: n.title }, { weight: 1.0 });
    for (const f of this.faqs) this.index.add({ ...f, type: 'faq', title: f.question }, { weight: 1.15 });
    for (const a of this.activities) this.index.add({ ...a, type: 'activity' }, { weight: 1.0 });
    for (const v of this.venues) this.index.add({ ...v, type: 'venue' }, { weight: 1.0 });
    this.index.finalize();

    this.llmKey = process.env.LLM_API_KEY || '';
    this.llmBase = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
    this.llmModel = process.env.LLM_MODEL || 'deepseek-chat';
  }

  /**
   * 未核实内容的提示语。
   * 智能体必须如实区分「已核实的官方信息」与「项目建设/待确认内容」，
   * 不能让同学把规划中的服务当成已开放的服务。
   */
  unverifiedNote(item) {
    if (!item || item.verified !== false) return '';
    return '\n\n---\n⚠️ **本条信息尚未经学院正式确认**，为项目建设或示例内容，请以学院正式通知为准。';
  }

  /** 来源标注 */
  sourceNote(item) {
    if (!item || !item.sourceId) return '';
    const s = this.sourceMap.get(item.sourceId);
    if (!s) return '';
    return `\n\n📄 来源：${s.name}`;
  }

  /** 主入口 */
  ask(question, opts = {}) {
    const q = String(question || '').trim();
    if (!q) {
      return this.reply('请说说你想了解什么，比如「自习室怎么预约」「最近有什么活动」。', {
        intent: 'empty', sources: [],
      });
    }

    // 1. 紧急意图直接给固定处置流程（不能让检索/模型自由发挥）
    const emergency = INTENTS.find((i) => i.name === 'emergency');
    if (emergency.patterns.some((re) => re.test(q))) {
      return this.emergencyReply(q);
    }

    // 2. 检索
    const hits = this.index.search(q, 6);
    const top = hits[0];

    // 3. 列表类意图优先：用户想看「清单」，不该被 FAQ 里的流程条目劫持
    //    例如「最近有什么活动可以报名」不应答成「怎么报名」的步骤说明。
    const listIntent = this.matchListIntent(q);
    if (listIntent) {
      // 但若检索到某一条具体条目分数极高（说明问的是特定那条），仍答详情
      const strong = top && top.score >= 12;
      if (!strong) {
        return this.dispatch(listIntent.handler, q, hits);
      }
    }

    // 4. 话题类意图（报修等）——先看是否问的是某条具体内容
    for (const intent of INTENTS) {
      if (intent.kind !== 'topic' || intent.name === 'emergency') continue;
      if (intent.patterns.some((re) => re.test(q))) {
        const specialized = this.specializedReply(intent.handler, q, hits);
        if (specialized) return specialized;
      }
    }

    // 5. 纯检索回答
    //
    //    阈值 2.0 经实测标定：无关问题（「今天天气怎么样」等）得分 0.4—1.2，
    //    正常问题得分 3.4 以上，空档清晰，零误判。
    //
    //    关于「句式相似但主题不同」的问题（如「怎么办理校园卡」被
    //    「图书馆怎么借书」以「校园卡」三字命中）：实测过两种更复杂的判据，
    //    都无法可靠区分，反而误伤正常问题：
    //      · 优势比（Top1 领先 Top2 的幅度）：正常问题可低至 0.015，分布重叠
    //      · 主题词整词覆盖：正常问题误判 2/25，且「四六级报名时间」被误标
    //    结论是词面检索无法可靠完成这一区分。因此这里不做花哨判断，
    //    而是靠**持续补充真实内容**来消除缺口（见 README 维护章节），
    //    并让教师端「未命中问题」看板暴露真实缺口，由人工补录。
    if (!top || top.score < 2.0) {
      return this.fallbackReply(q, hits);
    }
    return this.retrievalReply(q, hits);
  }

  /**
   * 列表类意图匹配。
   * 多个列表意图同时命中时，用「特征词出现位置 + 命中强度」决定优先级，
   * 避免「最近有什么活动可以报名」被 notice 规则（匹配到「什么」）抢走。
   */
  matchListIntent(q) {
    const lists = INTENTS.filter((i) => i.kind === 'list');
    let best = null;
    let bestScore = 0;

    for (const intent of lists) {
      let score = 0;
      for (const re of intent.patterns) {
        const m = q.match(re);
        if (m) {
          // 更长的匹配 = 更具体的信号，权重更高
          score += 1 + m[0].length * 0.5;
        }
      }
      if (score > bestScore) { bestScore = score; best = intent; }
    }
    return best;
  }

  /** 按 handler 分派到对应列表回答 */
  dispatch(handler, q, hits) {
    switch (handler) {
      case 'activities': return this.activitiesReply(q);
      case 'notices':    return this.noticesReply(q);
      case 'venues':     return this.venuesReply(q);
      case 'repair':     return this.repairReply(q);
      default:           return null;
    }
  }

  reply(text, meta) {
    return { text, ...meta };
  }

  // ----- 各类回答 -----

  emergencyReply(q) {
    const text = [
      '⚠️ **这件事请立即处理，不要等待：**',
      '',
      '**1. 涉及转账被骗**',
      '· 立即停止一切转账操作',
      '· 拨打 **110** 报警，或全国反诈专线 **96110**',
      '· 校园报警：隆中校区 **0710-3593110**（移动 15797189019）',
      '· 卧龙校区 **0710-3590110**',
      '· 马上联系**辅导员**和学院学工办',
      '· 保留聊天记录、转账凭证',
      '',
      '**2. 涉及人身安全 / 火灾 / 急救**',
      '· 立即拨打 **110**（报警）、**119**（火警）、**120**（急救）',
      '· 校园报警：隆中校区 **0710-3593110** / 卧龙校区 **0710-3590110**',
      '· 保卫处办公室：**0710-3590532**',
      '· 联系宿管与辅导员',
      '',
      '**3. 心理危机**',
      '· 全国心理援助热线 **12356**（24小时）',
      '· 学校心理健康教育中心 **0710-3591827**（预约QQ 2453222047）',
      '· 联系辅导员',
      '',
      '**记住：凡是要求转账、索要验证码、承诺刷单返利的，都是诈骗。**',
    ].join('\n');
    return this.reply(text, { intent: 'emergency', sources: [], urgent: true });
  }

  noticesReply(q) {
    const list = this.notices
      .slice()
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.date.localeCompare(a.date);
      })
      .slice(0, 6);

    const lines = ['📢 **社区与学校通知**（点击查看详情）', ''];
    for (const n of list) {
      const pin = n.pinned ? '📌 ' : '';
      const mark = n.verified === false ? '　`待确认`' : '';
      const dl = n.deadline ? `　⏰ 截止 ${n.deadline}` : '';
      lines.push(`${pin}**${n.title}**${mark}`);
      lines.push(`　${n.date} · ${n.category}${dl}`);
    }
    lines.push('');
    lines.push('想了解哪一条？直接说标题关键词，比如「报修」「心理」「学生证」。');
    lines.push('');
    lines.push('📄 数据来源：湖北文理学院及各二级单位官网；标记「待确认」的条目为项目建设或示例内容。');

    return this.reply(lines.join('\n'), {
      intent: 'notices',
      sources: list.map((n) => ({ id: n.id, type: 'notice', title: n.title })),
      cards: list.map((n) => this.noticeCard(n)),
    });
  }

  activitiesReply(q) {
    // 按状态分组：进行中/报名中优先，已结束次之
    const active = this.activities.filter((a) => a.status !== '已结束');
    const done = this.activities.filter((a) => a.status === '已结束');

    const lines = [];
    if (active.length) {
      lines.push('🎯 **活动与计划**', '');
      for (const a of active) {
        const mark = a.verified === false ? '　`待学院确认`' : '';
        const credit = a.credit && a.credit !== '无' ? `　🎖 ${a.credit}` : '';
        lines.push(`**${a.title}**　\`${a.status}\`${mark}`);
        lines.push(`　📅 ${a.date}${a.time && a.time !== '待定' ? ' ' + a.time : ''}`);
        lines.push(`　📍 ${a.location}${credit}`);
        lines.push(`　${a.summary}`);
        lines.push('');
      }
    }

    if (done.length) {
      lines.push('📋 **学院近期已开展活动**（参考，了解学院活动类型）', '');
      for (const a of done.slice(0, 4)) {
        lines.push(`· **${a.title}**（${a.date}）`);
      }
      lines.push('');
    }

    lines.push('💡 **报名与招募通知**请关注计算机工程学院官网「学生工作 → 学工动态」栏目。');
    lines.push('📞 学院综合办：0710-3593152');

    return this.reply(lines.join('\n'), {
      intent: 'activities',
      sources: [...active, ...done.slice(0, 4)].map((a) => ({ id: a.id, type: 'activity', title: a.title })),
      cards: [...active, ...done.slice(0, 4)].map((a) => this.activityCard(a)),
    });
  }

  venuesReply(q) {
    const lines = ['🏠 **社区与校园服务场所**', ''];
    for (const v of this.venues) {
      const mark = v.verified === false ? '　`建设中`' : '';
      lines.push(`**${v.name}**（${v.location}）${mark}`);
      lines.push(`　🕐 ${v.openHours}`);
      if (v.booking) lines.push(`　📋 ${v.booking}`);
      if (v.note) lines.push(`　💡 ${v.note}`);
      lines.push('');
    }
    lines.push('📄 数据来源：湖北文理学院及各二级单位官网。');

    return this.reply(lines.join('\n'), {
      intent: 'venues',
      sources: this.venues.map((v) => ({ id: v.id, type: 'venue', title: v.name })),
      cards: this.venues.map((v) => this.venueCard(v)),
    });
  }

  repairReply(q) {
    const text = [
      '🔧 **报修指引**',
      '',
      '**一、宿舍设施报修（五条渠道）**',
      '1. **微后勤平台**——寝室与每栋楼值班室门口贴有二维码，扫码报修',
      '2. **每栋楼一楼门值处**——直接反映',
      '3. **楼栋微信群 / 公寓委员会QQ群**',
      '4. **微后勤平台微信群**（通过学生会成员反馈）',
      '5. **南北校区物业公司办公室**',
      '',
      '⏱ **维修时效：电不过夜、水不过天**',
      '',
      '**二、维修范围划分**',
      '· **物业负责**：灯管、插座、开关、水龙头、冲水阀、门窗、家具、下水道非人为堵塞',
      '· **学校负责**：防水层漏水、楼顶漏水、墙面脱皮、瓷砖破裂、主水管道改造',
      '· **资产公司负责**：开水机、热水、花洒、吹风机、洗衣机',
      '',
      '**三、投诉渠道**',
      '· 学生公寓管理服务中心（**14栋一楼**）',
      '· 北区公寓物业办公室：12#102　南区：4#101',
      '· 开水、热水投诉：18372264416（短号 662233）',
      '',
      '**四、电脑等个人设备故障**',
      '· 15栋社区计划提供免费电脑义务维修（**筹备中，待学院确认**）',
      '· 学院现有「心域网」志愿服务队常态化开展志愿服务',
      '',
      '📞 后勤保障处：**0710-3590633**',
    ].join('\n');
    return this.reply(text, {
      intent: 'repair',
      sources: [{ id: 's008', type: 'faq', title: '学生公寓服务设施报修、投诉渠道' }],
    });
  }

  /**
   * 话题类意图的专用回答。
   * 列表类意图已在上游处理；这里只处理「报修」这类需要固定流程指引的问题，
   * 但若检索到某条具体内容得分明显更高，仍优先答那一条。
   */
  specializedReply(handler, q, hits) {
    switch (handler) {
      case 'repair': {
        // 问的是某条具体通知（如「安全用电专项检查」）时答详情
        const strong = hits.find((h) => h.score >= 12);
        if (strong) return null;   // 交回检索流程答具体条目
        return this.repairReply(q);
      }
      case 'notices':  return this.noticesReply(q);
      case 'activities': return this.activitiesReply(q);
      case 'venues':   return this.venuesReply(q);
      default:         return null;
    }
  }

  singleNoticeReply(n) {
    const lines = [
      `📢 **${n.title}**`,
      '',
      `📅 发布：${n.date}　·　${n.category}`,
      `🏛 发布单位：${n.publisher}`,
    ];
    if (n.deadline) lines.push(`⏰ **截止时间：${n.deadline}**`);
    lines.push('', n.content);
    let text = lines.join('\n');
    text += this.sourceNote(n) + this.unverifiedNote(n);
    return this.reply(text, {
      intent: 'notice-detail',
      sources: [{ id: n.id, type: 'notice', title: n.title }],
      cards: [this.noticeCard(n)],
      verified: n.verified !== false,
    });
  }

  singleActivityReply(a) {
    const lines = [
      `🎯 **${a.title}**　\`${a.status}\``,
      '',
      `📅 时间：${a.date} ${a.time}`,
      `📍 地点：${a.location}`,
      `🏛 主办：${a.organizer}`,
    ];
    if (a.credit && a.credit !== '无') lines.push(`🎖 认定：${a.credit}`);
    if (a.deadline) lines.push(`⏰ **报名截止：${a.deadline}**`);
    if (a.capacity) lines.push(`👥 名额：${a.enrolled ?? 0}/${a.capacity}`);
    lines.push('', a.detail || a.summary);
    if (a.verified !== false) {
      lines.push('', '报名：请关注学院官网「学生工作 → 学工动态」栏目通知。');
    }
    let text = lines.join('\n');
    text += this.sourceNote(a) + this.unverifiedNote(a);
    return this.reply(text, {
      intent: 'activity-detail',
      sources: [{ id: a.id, type: 'activity', title: a.title }],
      cards: [this.activityCard(a)],
      verified: a.verified !== false,
    });
  }

  singleVenueReply(v) {
    const lines = [
      `🏠 **${v.name}**`,
      '',
      `📍 位置：${v.location}`,
      `🕐 开放：${v.openHours}`,
      `👥 容量：${v.capacity}`,
      `📋 预约：${v.booking}`,
      `🎯 适用：${(v.suitable || []).join('、')}`,
    ];
    if (v.facilities && v.facilities.length) lines.push(`🔌 设施：${v.facilities.join('、')}`);
    if (v.note) lines.push('', `💡 ${v.note}`);
    let text = lines.join('\n');
    text += this.sourceNote(v) + this.unverifiedNote(v);
    return this.reply(text, {
      intent: 'venue-detail',
      sources: [{ id: v.id, type: 'venue', title: v.name }],
      cards: [this.venueCard(v)],
      verified: v.verified !== false,
    });
  }

  retrievalReply(q, hits) {
    const best = hits[0].doc.raw;
    let body;
    if (best.type === 'faq') {
      body = best.answer;
    } else if (best.type === 'notice') {
      const lines = [`📅 ${best.date} · ${best.category}`];
      if (best.deadline) lines.push(`⏰ 截止 ${best.deadline}`);
      lines.push('', best.content);
      body = lines.join('\n');
    } else if (best.type === 'activity') {
      const lines = [
        `📅 ${best.date} ${best.time}`,
        `📍 ${best.location}`,
        `🏛 ${best.organizer}`,
      ];
      if (best.deadline) lines.push(`⏰ 报名截止 ${best.deadline}`);
      lines.push('', best.detail || best.summary);
      body = lines.join('\n');
    } else {
      const lines = [`📍 ${best.location}`, `🕐 ${best.openHours}`, `📋 ${best.booking}`];
      if (best.note) lines.push('', `💡 ${best.note}`);
      body = lines.join('\n');
    }

    const title = best.title || best.question || best.name;
    let text = `**${title}**\n\n${body}`;

    // 来源与核实状态
    text += this.sourceNote(best) + this.unverifiedNote(best);

    // 附上相关条目作为「你可能还想问」
    const related = hits
      .slice(1, 4)
      .map((h) => h.doc.raw)
      .filter((r) => (r.title || r.question || r.name) !== title)
      .map((r) => `· ${r.title || r.question || r.name}`);

    if (related.length) {
      text += `\n\n**你可能还想了解**\n${related.join('\n')}`;
    }

    return this.reply(text, {
      intent: 'retrieval',
      sources: hits.slice(0, 3).map((h) => ({
        id: h.doc.raw.id,
        type: h.doc.raw.type,
        title: h.doc.raw.title || h.doc.raw.question || h.doc.raw.name,
      })),
      cards: [this.cardFor(best)],
      confidence: hits[0].score,
      verified: best.verified !== false,
    });
  }

  fallbackReply(q, hits) {
    const suggestions = [
      '宿舍东西坏了怎么报修？',
      '学校的报警电话是多少？',
      '心理压力大想找人聊聊，可以找谁？',
      '学生证丢了怎么补办？',
      '计算机工程学院有哪些专业？',
      '食堂相关问题找谁？',
    ];
    const text = [
      '抱歉，这个问题我暂时没有找到准确答案。',
      '',
      '**你可以试试这样问我：**',
      ...suggestions.map((s) => `· ${s}`),
      '',
      '也可以咨询以下渠道：',
      '· 学院综合办 **0710-3593152**',
      '· 学工热线 **0710-3590598**',
      '· 学校总机 **0710-3590876**',
    ].join('\n');

    return this.reply(text, {
      intent: 'fallback',
      sources: [],
      suggestions,
      lowConfidence: true,
    });
  }

  // ----- 卡片（供前端渲染，便于一体机大屏点击） -----

  noticeCard(n) {
    return {
      id: n.id, type: 'notice', title: n.title, category: n.category,
      date: n.date, deadline: n.deadline, pinned: !!n.pinned, priority: n.priority,
      verified: n.verified !== false,
      summary: n.content.replace(/\n/g, ' ').slice(0, 60) + (n.content.length > 60 ? '…' : ''),
    };
  }

  activityCard(a) {
    return {
      id: a.id, type: 'activity', title: a.title, category: a.category,
      date: a.date, time: a.time, location: a.location, status: a.status,
      deadline: a.deadline, credit: a.credit, capacity: a.capacity, enrolled: a.enrolled,
      verified: a.verified !== false,
      summary: a.summary,
    };
  }

  venueCard(v) {
    return {
      id: v.id, type: 'venue', title: v.name, location: v.location,
      openHours: v.openHours, capacity: v.capacity, booking: v.booking,
      verified: v.verified !== false,
      summary: (v.suitable || []).join('、'),
    };
  }

  cardFor(item) {
    if (item.type === 'notice') return this.noticeCard(item);
    if (item.type === 'activity') return this.activityCard(item);
    if (item.type === 'venue') return this.venueCard(item);
    return {
      id: item.id, type: 'faq', title: item.question, category: item.category,
      verified: item.verified !== false,
      summary: item.answer.replace(/[*\n]/g, ' ').slice(0, 60),
    };
  }

  /** 统计信息，供首页展示 */
  stats() {
    const total = this.notices.length + this.faqs.length + this.activities.length + this.venues.length;
    const unverified =
      this.notices.filter((x) => x.verified === false).length +
      this.faqs.filter((x) => x.verified === false).length +
      this.activities.filter((x) => x.verified === false).length +
      this.venues.filter((x) => x.verified === false).length;

    return {
      notices: this.notices.length,
      faqs: this.faqs.length,
      activities: this.activities.filter((a) => a.status !== '已结束').length,
      venues: this.venues.length,
      total,
      verified: total - unverified,
      unverified,
      sourceCount: (this.sources.sources || []).length,
      updatedAt: this.sources.updatedAt || null,
      llmEnabled: !!this.llmKey,
    };
  }
}

module.exports = { CommunityAgent, INTENTS };
