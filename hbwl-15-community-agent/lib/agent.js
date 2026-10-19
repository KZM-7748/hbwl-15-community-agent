'use strict';

/**
 * 智能体大脑 —— 意图识别 + 检索 + 回答生成
 *
 * 工作方式（三级）：
 *   1. 规则意图层：识别「通知/活动/自习预约/报修/紧急」等明确意图，走专用数据通道
 *   2. 检索层：BM25 检索 FAQ + 通知 + 活动 + 场地，取最相关条目
 *   3. 兜底层：置信度不足时给出引导式回答，而不是硬编一个错误答案
 *
 * ── 关于大模型（重要说明）────────────────────────────────
 *   当前版本**完全离线运行，不调用任何大模型**。
 *
 *   constructor 中读取的 llmKey / llmBase / llmModel，
 *   以及 stats() 返回的 llmEnabled 标志，都是**为后续接入预留的位置**：
 *   全项目没有任何代码真正发起过大模型请求。
 *
 *   因此设置 LLM_API_KEY 只会让 llmEnabled 显示为 true，
 *   不会改变任何回答行为。这一点已在文档中如实说明，
 *   接入方案与必要性分析见「人工智能接入说明.md」。
 * ────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const { SearchIndex } = require('./retrieval');

const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * 本地日期（YYYY-MM-DD）。
 * 注意不能用 toISOString()——那是 UTC 时间，
 * 东八区在凌晨 0–8 点之间会得到「昨天」的日期，
 * 导致活动状态的判断偏差一天。
 */
function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
    // 大模型配置（与知识库无关，只需设置一次）
    this.llmKey = process.env.LLM_API_KEY || '';
    this.llmBase = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
    this.llmModel = process.env.LLM_MODEL || 'deepseek-chat';

    // 版本号：每次重新加载知识库递增，用于确认内存数据是否为最新
    this.revision = 0;
    this.loadedAt = 0;

    this.reload();
  }

  /**
   * 从磁盘重新加载知识库并重建检索索引。
   *
   * 为什么需要这个方法：
   *   教师端发布/修改/删除内容时，写的是 data/ 下的 JSON 文件，
   *   而问答用的是内存中的 this.notices / this.faqs / this.index。
   *   若不在内容变更后调用本方法，教师端改了内容、学生端却查不到，
   *   必须重启服务才生效 —— 这会让教师端形同虚设。
   *
   * 调用时机：ContentManager 每次写入成功后（见 server.js）。
   *
   * 性能：当前知识库 62 条，重建索引约 1 ms（见 scripts/benchmark.js），
   *       远低于人类操作间隔，无需做增量更新。
   */
  reload() {
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
    const index = new SearchIndex();
    for (const n of this.notices) index.add({ ...n, type: 'notice', text: n.title }, { weight: 1.0 });
    for (const f of this.faqs) index.add({ ...f, type: 'faq', title: f.question }, { weight: 1.15 });
    for (const a of this.activities) index.add({ ...a, type: 'activity' }, { weight: 1.0 });
    for (const v of this.venues) index.add({ ...v, type: 'venue' }, { weight: 1.0 });
    index.finalize();

    // 原子替换：先构建完成再赋值，避免查询过程中看到半成品索引
    this.index = index;
    this.revision++;
    this.loadedAt = Date.now();
  }

  /** 知识库规模摘要，供日志与自检使用 */
  summary() {
    return {
      revision: this.revision,
      loadedAt: this.loadedAt,
      notices: this.notices.length,
      faqs: this.faqs.length,
      activities: this.activities.length,
      venues: this.venues.length,
    };
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
    //    ── 阈值经实测标定，不是猜的 ─────────────────────────────
    //    用 10 个正常问题 + 8 个真实缺口问题测得分分布：
    //      正常问题：35.91 ~ 70.77（最低是「校园卡怎么办理」35.91）
    //      缺口问题： 7.86 ~ 24.80（最高是「怎么申请助学金」24.80）
    //    中间有 11 分的空档，因此把低置信度阈值设在 30 —— 零误判。
    //
    //    缺口问题的典型表现（系统"以为"答上了，实际答非所问）：
    //      「校车几点发车」   → 答「宿舍几点熄灯」      7.86
    //      「食堂几点开门」   → 答「图书馆开放时间」   13.23
    //      「宿舍可以养猫吗」 → 答「能不能用吹风机」   12.15
    //
    //    ── 三档处理 ────────────────────────────────────────────
    //      · 低于 2.0   → 兜底，明确说「没找到」
    //      · 低于 30    → 正常回答 + 标注 lowConfidence
    //                     （回答里提示可能不对应，并计入教师端待补充清单）
    //      · 30 以上    → 正常回答
    //
    //    低置信度仍给出回答（相邻信息往往有用），只是标明不确定。
    //    真正判断准不准的是同学的「没用」反馈，算法只负责提示。
    if (!top || top.score < 2.0) {
      return this.fallbackReply(q, hits);
    }

    const reply = this.retrievalReply(q, hits);

    const LOW_CONFIDENCE = 30;
    if (top.score < LOW_CONFIDENCE) {
      reply.lowConfidence = true;
      reply.text += '\n\n---\n💡 **这条回答可能不完全对应你的问题。**'
        + '如果没解决你的疑问，可以换个说法再问，或点下方「👎 没用」告诉老师补充。';
    }
    return reply;
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

  /**
   * 计算活动的「实际状态」。
   *
   * 为什么不能直接用 activities.json 里的 status 字段：
   *   那是教师手工填写的静态值。一旦学院发布带截止日期的活动，
   *   过了截止日之后 status 仍写着「报名中」，同学会白跑一趟。
   *   实测确认过这个隐患（插入一条截止 10-10 的活动，10-17 仍显示「报名中」）。
   *
   * 规则（以日期为准，人工填写仅作参考）：
   *   · 报名截止日已过，且活动日期未到  → 「报名已截止」
   *   · 活动日期已过                     → 「已结束」
   *   · 活动日期是今天                   → 「进行中」
   *   · 日期为「待定」或无法解析          → 沿用人工填写的 status
   *
   * @returns {{status:string, expired:boolean, reason:string}}
   */
  effectiveStatus(a, today = todayStr()) {
    const raw = String(a.status || '').trim();
    const dateStr = String(a.date || '').trim();
    const deadlineStr = String(a.deadline || '').trim();

    const isRealDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const dateKnown = isRealDate(dateStr);
    const deadlineKnown = isRealDate(deadlineStr);

    // 活动日期已过 → 已结束
    if (dateKnown && dateStr < today) {
      return { status: '已结束', expired: true, reason: '活动日期已过' };
    }

    // 报名截止已过，但活动还没开始
    if (deadlineKnown && deadlineStr < today && (!dateKnown || dateStr >= today)) {
      // 若活动就在今天，算进行中而不是报名已截止
      if (dateKnown && dateStr === today) {
        return { status: '进行中', expired: false, reason: '活动今天举行' };
      }
      return { status: '报名已截止', expired: true, reason: `报名截止 ${deadlineStr} 已过` };
    }

    // 活动就在今天
    if (dateKnown && dateStr === today) {
      return { status: '进行中', expired: false, reason: '活动今天举行' };
    }

    // 日期未知（如「待定」）→ 沿用人工填写
    if (!dateKnown) {
      return { status: raw || '待定', expired: false, reason: '日期待定，沿用人工标注' };
    }

    // 未来活动 → 沿用人工填写（报名中 / 预告）
    return { status: raw || '预告', expired: false, reason: '未来活动' };
  }

  activitiesReply(q) {
    // 按实际状态分组：有效活动优先，已结束/已截止次之
    const evaluated = this.activities.map((a) => ({ a, st: this.effectiveStatus(a) }));
    const active = evaluated.filter((x) => !x.st.expired).map((x) => x.a);
    const inactive = evaluated.filter((x) => x.st.expired).map((x) => x.a);

    const lines = [];
    if (active.length) {
      lines.push('🎯 **活动与计划**', '');
      for (const a of active) {
        const st = this.effectiveStatus(a);
        const mark = a.verified === false ? '　`待学院确认`' : '';
        const credit = a.credit && a.credit !== '无' ? `　🎖 ${a.credit}` : '';
        lines.push(`**${a.title}**　\`${st.status}\`${mark}`);
        lines.push(`　📅 ${a.date}${a.time && a.time !== '待定' ? ' ' + a.time : ''}`);
        if (a.deadline) lines.push(`　⏰ 报名截止 ${a.deadline}`);
        lines.push(`　📍 ${a.location}${credit}`);
        lines.push(`　${a.summary}`);
        lines.push('');
      }
    }

    if (inactive.length) {
      lines.push('📋 **已结束 / 已截止的活动**', '');
      for (const a of inactive.slice(0, 6)) {
        const st = this.effectiveStatus(a);
        lines.push(`· **${a.title}**（${a.date}）— ${st.status}`);
      }
      lines.push('');
    }

    lines.push('💡 **报名与招募通知**请关注计算机工程学院官网「学生工作 → 学工动态」栏目。');
    lines.push('📞 学院综合办：0710-3593152');

    return this.reply(lines.join('\n'), {
      intent: 'activities',
      sources: [...active, ...inactive.slice(0, 6)].map((a) => ({ id: a.id, type: 'activity', title: a.title })),
      cards: [...active, ...inactive.slice(0, 6)].map((a) => this.activityCard(a)),
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
    const st = this.effectiveStatus(a);
    const lines = [
      `🎯 **${a.title}**　\`${st.status}\``,
      '',
      `📅 时间：${a.date} ${a.time}`,
      `📍 地点：${a.location}`,
      `🏛 主办：${a.organizer}`,
    ];
    if (a.credit && a.credit !== '无') lines.push(`🎖 认定：${a.credit}`);
    if (a.deadline) {
      const passed = st.expired && st.reason.includes('报名截止');
      lines.push(`⏰ **报名截止：${a.deadline}**${passed ? '（已过）' : ''}`);
    }
    if (a.capacity) lines.push(`👥 名额：${a.enrolled ?? 0}/${a.capacity}`);
    lines.push('', a.detail || a.summary);

    // 已结束/已截止的活动，明确提示不要再前往
    if (st.expired) {
      lines.push('', `⚠️ **本活动${st.status}**（${st.reason}），请勿再前往或报名。`);
      lines.push('如需了解后续安排，请关注学院官网或咨询学院综合办 0710-3593152。');
    } else if (a.verified !== false) {
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

    // 相关条目：通过 cards 返回，由前端渲染成可点击卡片。
    //
    // 这里**不再**在正文里重复列一遍「你可能还想了解」——
    // 早期版本正文列一遍、sources 渲染成标签、cards 又渲染成卡片，
    // 同一个标题出现三次，页面显得杂乱且浪费纵向空间。
    // 卡片可点击查看详情，比纯文本列表更有用。
    const relatedRaw = hits
      .slice(1, 4)
      .map((h) => h.doc.raw)
      .filter((r) => (r.title || r.question || r.name) !== title);

    return this.reply(text, {
      intent: 'retrieval',
      sources: hits.slice(0, 3).map((h) => ({
        id: h.doc.raw.id,
        type: h.doc.raw.type,
        title: h.doc.raw.title || h.doc.raw.question || h.doc.raw.name,
      })),
      cards: [this.cardFor(best), ...relatedRaw.map((r) => this.cardFor(r))],
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

  /**
   * 把正文压成卡片上的一句话摘要。
   *
   * 卡片是纯文本渲染（前端用 escapeHTML），如果直接把带 Markdown 的正文塞进去，
   * 同学会看到字面的 `**粗体**` 和成串的换行 —— 实测截图里确实出现过这个问题。
   * 因此这里先剥掉 Markdown 标记、压平空白，再截断。
   */
  toSummary(text, max = 60) {
    const flat = String(text || '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')     // 粗体
      .replace(/`([^`]+)`/g, '$1')           // 行内代码
      .replace(/^[#>\-\*\+]\s*/gm, '')       // 标题、引用、列表符号
      .replace(/^\d+[.、)]\s*/gm, '')        // 有序列表
      .replace(/^---+$/gm, ' ')              // 分隔线
      .replace(/[\r\n]+/g, ' ')              // 换行压成空格
      .replace(/\s{2,}/g, ' ')               // 连续空白合并
      .trim();
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  }

  noticeCard(n) {
    return {
      id: n.id, type: 'notice', title: n.title, category: n.category,
      date: n.date, deadline: n.deadline, pinned: !!n.pinned, priority: n.priority,
      verified: n.verified !== false,
      summary: this.toSummary(n.content),
    };
  }

  activityCard(a) {
    // 用「实际状态」而非人工填写的 status，避免过期活动仍显示「报名中」
    const st = this.effectiveStatus(a);
    return {
      id: a.id, type: 'activity', title: a.title, category: a.category,
      date: a.date, time: a.time, location: a.location,
      status: st.status,
      expired: st.expired,
      rawStatus: a.status,        // 保留人工标注，便于教师端对照
      deadline: a.deadline, credit: a.credit, capacity: a.capacity, enrolled: a.enrolled,
      verified: a.verified !== false,
      summary: this.toSummary(a.summary || a.detail, 60),
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
      summary: this.toSummary(item.answer, 60),
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
