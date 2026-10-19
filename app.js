/* 西安一日行程规划 —— 核心逻辑 + 页面交互（classic script，file:// 可直接打开）
 * =====================================================================
 * 结构说明：
 *  1) 上半部分是纯函数（距离 / 出行方式 / 排序 / 时间轴 / 预算 / 疲劳），
 *     不碰 DOM，可以在 Node 下 require 做冒烟测试：
 *       const m = require('./app.js');
 *       m.haversine(a, b) / m.buildPlan(['xingqing', ...], {...}) ...
 *  2) 下半部分是页面初始化 initApp()，用 typeof document 保护，
 *     所以 Node require 时不会因 document is not defined 报错。
 * 数据由 data.js 提供（浏览器：window.PLACES；Node：require('./data.js')）。
 * ===================================================================== */
'use strict';

/* ============ 0. 载入地点数据 ============ */
let PLACES_DATA = [];
if (typeof window !== 'undefined' && window.PLACES) {
  PLACES_DATA = window.PLACES;
} else if (typeof require === 'function') {
  PLACES_DATA = require('./data.js').PLACES;
}

/* ============ 1. 可调参数（README 里有「怎么改算法参数」说明） ============ */
const CFG = {
  roadFactor: 1.2,              // 直线距离 → 道路距离的弯曲系数（brief 要求 1.2–1.3）
  walkMaxKm: 0.8,               // ≤ 这个距离就步行
  buffer: { walk: 0, bus: 5, metro: 6, taxi: 3 },    // 等车 / 进出站缓冲（分钟）
  speed: { walk: 5, bus: 20, metro: 35, taxi: 30 },  // 平均速度（km/h）
  meals: [
    { start: 11 * 60 + 30, end: 13 * 60 + 30, label: '午饭' }, // 11:30–13:30
    { start: 17 * 60 + 30, end: 19 * 60 + 30, label: '晚饭' }  // 17:30–19:30
  ],
  fatigueBands: [
    { max: 8, label: '轻松' },
    { max: 15, label: '适中' },
    { max: 24, label: '偏累' },
    { max: Infinity, label: '很累' }
  ],
  defaults: {
    originId: 'xingqing',
    date: '',
    startTime: '09:00',
    endTime: '20:00',
    budget: 'economy',
    people: 2,
    strategy: 'balanced',
    variant: 0
  },
  preselected: ['xingqing', 'innovation', 'qinyu', 'tianxia']
};

/* 高德 Web 服务 Key（等用户提供后填入；留空 = 只用官方深链降级，不编造线路号）。
   也可在控制台临时覆盖：localStorage.setItem('xian-trip-amap-key', '你的Key') */
const AMAP_KEY = '0dffc6f2066d39f0c3d8f18ded129e82';
const MODE_COLOR = { walk: '#2e7d32', bus: '#1565c0', metro: '#ef6c00', taxi: '#c62828' };
const MODE_OPTIONS = ['walk', 'bus', 'metro', 'taxi'];

const MODE_LABEL = { walk: '步行', bus: '公交', metro: '地铁', taxi: '打车', start: '起点' };
const CAT_LABEL = { sight: '景点', food: '饭店', campus: '校园地标', hub: '交通集散' };
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const STRATEGY_LABEL = { balanced: '标准方案', 'less-tiring': '更省力', 'less-money': '更省钱' };

/* ============ 2. 小工具 ============ */

/** "09:30" → 570（分钟） */
function toMin(hhmm) {
  const parts = String(hhmm || '00:00').split(':');
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  return h * 60 + m;
}

/** 570 → "09:30" */
function toHHMM(min) {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return String(h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
}

/** 超过 24:00 的时间显示「次日 HH:MM」，避免出现 04:28 这种歧义（N1） */
function fmtClock(min) {
  const v = Math.round(Number(min) || 0);
  if (v >= 1440) return '次日 ' + toHHMM(v - 1440);
  return toHHMM(v);
}

/** 解析 YYYY-MM-DD；不合法时回退到今天（本地时区） */
function parseDate(str) {
  if (str && /^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(str + 'T12:00:00');
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

/* ============ 3. 距离与出行方式 ============ */

/** haversine 球面直线距离（km）。参数是 {lat, lng}。 */
function haversine(a, b) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const la1 = a.lat * toRad;
  const la2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 道路距离估计 = 直线距离 × 弯曲系数 */
function roadDistance(a, b) {
  return haversine(a, b) * CFG.roadFactor;
}

/**
 * 选择出行方式（brief 5.1 规则）：
 *  ≤0.8km 步行；>8km 默认地铁或打车；经济档优先地铁/公交，舒适档优先打车。
 *  strategy：「更省力」优先打车、「更省钱」优先公交/地铁。
 */
function pickMode(km, budget, strategy) {
  if (!(km > 0.05)) return 'walk';
  if (km <= CFG.walkMaxKm) return 'walk';
  const s = strategy || 'balanced';
  if (s === 'less-tiring') return 'taxi';
  // 「更省钱」：长途优先 2 元公交（比地铁省），用时间换钱；但 >10km 必须地铁（跨校区 30–40km 禁止公交/步行）
  if (s === 'less-money') return km > 10 ? 'metro' : 'bus';
  if (budget === 'comfort') return km <= 1.5 ? 'walk' : 'taxi';
  return km <= 8 ? 'bus' : 'metro';
}

/**
 * 某段交通的时间 / 费用 / 疲劳增量
 * 费用口径（B2 / AC-07 / E7）：所有方式（含打车）都按「元/人 × 人数」估算，
 *   打车费=起步价+里程费的整车估算再按人头计（多人共乘时实际更低，README 已注明）。
 * 疲劳增量：步行按公里数 +1/km，其余方式很低（0.2–0.3/段）。
 */
function travelInfo(km, mode, people) {
  const p = Math.max(1, Math.round(Number(people) || 1));
  let minutes = 0;
  let cost = 0;
  let fatigue = 0;
  if (mode === 'walk') {
    minutes = Math.max(1, Math.round((km / CFG.speed.walk) * 60));
    cost = 0;
    fatigue = km * 1;
  } else if (mode === 'bus') {
    minutes = Math.max(1, Math.round((km / CFG.speed.bus) * 60) + CFG.buffer.bus);
    cost = 2 * p;
    fatigue = 0.25;
  } else if (mode === 'metro') {
    minutes = Math.max(1, Math.round((km / CFG.speed.metro) * 60) + CFG.buffer.metro);
    const perPerson = Math.min(6, Math.max(3, Math.round(3 + km * 0.12))); // 3–6 元/人
    cost = perPerson * p;
    fatigue = 0.3;
  } else if (mode === 'taxi') {
    minutes = Math.max(1, Math.round((km / CFG.speed.taxi) * 60) + CFG.buffer.taxi);
    const perPerson = Math.round(10 + Math.max(0, km - 3) * 2); // 起步约 10 元/3km + 约 2 元/km
    cost = perPerson * p;
    fatigue = 0.2;
  }
  return { minutes, cost, fatigue };
}

/**
 * 每段「推荐方式 + 理由」：用 travelInfo 实算对比各方式的时间/费用，不写死文案。
 * @returns {{mode:string, reason:string, options:object}}
 */
function recommendLeg(km, budget, strategy, people) {
  const p = Math.max(1, Math.round(Number(people) || 1));
  const mode = pickMode(km, budget, strategy);
  const options = {};
  MODE_OPTIONS.forEach((m) => { options[m] = travelInfo(km, m, p); });
  const rec = options[mode];
  const budgetText = budget === 'comfort' ? '舒适档' : '经济档';
  let reason = km.toFixed(1) + ' km · ' + budgetText + '；' + MODE_LABEL[mode] +
    '约 ' + rec.minutes + ' 分钟、约¥' + Math.round(rec.cost / p) + '/人';
  if (mode === 'walk') {
    reason += '；步行 0 元，这段路直接走过去最省事';
  } else if (mode === 'taxi') {
    const fastest = Math.min(options.bus.minutes, options.metro.minutes);
    const diff = rec.minutes - fastest; // 正数=打车更慢
    reason += diff > 0
      ? '；比公交/地铁慢约 ' + diff + ' 分钟，贵约 ¥'
      : '；比公交/地铁快约 ' + Math.max(0, -diff) + ' 分钟，贵约 ¥';
    reason += Math.max(0, Math.round((rec.cost - options.metro.cost) / p)) + '/人';
  } else {
    const save = Math.round((options.taxi.cost - rec.cost) / p);
    reason += '；比打车省约 ¥' + Math.max(0, save) + '/人';
    if (options.bus.minutes < rec.minutes) reason += '，比公交快约 ' + (rec.minutes - options.bus.minutes) + ' 分钟';
  }
  return { mode, reason, options };
}

/* ============ 高德深链（纯函数，Node 可测；B4 方式映射） ============ */
function amapLinkMode(mode) {
  if (mode === 'walk') return 'walk';
  if (mode === 'taxi') return 'car';
  return 'bus';
}

function amapLinkLabel(mode) {
  if (mode === 'walk') return '高德步行导航';
  if (mode === 'taxi') return '高德驾车导航';
  return '查看实时公交/地铁换乘（高德）';
}

/** 高德官方深链：坐标/名称/方式都按本段数据生成 */
function amapDeepLink(row) {
  const from = row.fromLng + ',' + row.fromLat + ',' + encodeURIComponent(row.fromName);
  const to = row.place.lng + ',' + row.place.lat + ',' + encodeURIComponent(row.place.name);
  return 'https://uri.amap.com/navigation?from=' + from + '&to=' + to + '&mode=' + amapLinkMode(row.mode) + '&callnative=0';
}

/* ============ 4. 排序：贪心 + 2-opt（brief 5.5） ============ */

/** 从 origin 出发的最邻近贪心；startIndex 可指定第一个要去的点。 */
function greedyOrder(places, origin, startIndex) {
  const left = places.slice();
  const out = [];
  let cur = origin;
  if (typeof startIndex === 'number' && startIndex >= 0 && startIndex < left.length) {
    const first = left.splice(startIndex, 1)[0];
    out.push(first);
    cur = first;
  }
  while (left.length) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < left.length; i += 1) {
      const d = roadDistance(cur, left[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    const p = left.splice(bi, 1)[0];
    out.push(p);
    cur = p;
  }
  return out;
}

/** 一条顺序的总道路里程（含 from origin 的第一段） */
function tourDistance(order, origin) {
  let d = 0;
  let prev = origin;
  for (let i = 0; i < order.length; i += 1) {
    d += roadDistance(prev, order[i]);
    prev = order[i];
  }
  return d;
}

/**
 * 2-opt 局部优化：反复尝试反转顺序中的一段，能减少总里程就保留。
 * 对 ≤25 个点是 O(n²) 级别，完全够用。
 */
function twoOpt(order, origin) {
  const n = order.length;
  if (n < 3) return order.slice();
  let best = order.slice();
  let bestD = tourDistance(best, origin);
  let improved = true;
  let guard = 0;
  while (improved && guard < 60) {
    improved = false;
    guard += 1;
    for (let i = 1; i < n - 1; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const d = tourDistance(cand, origin);
        if (d < bestD - 1e-6) {
          best = cand;
          bestD = d;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * 生成访问顺序：
 *  variant 0 = 标准（最近邻 + 2-opt）
 *  variant 1 = 换个起点（先选最远的点，再最近邻 + 2-opt）
 *  variant 2 = 按区域聚类（先把同一片逛完，减少跨区折返）
 * 「重新生成」按钮会轮换 variant，给出另一种顺路方案。
 */
function orderPlaces(places, origin, strategy, variant) {
  if (!places.length) return [];
  const v = Number(variant) || 0;
  let order;
  if (v === 2) {
    const areas = [];
    places.forEach((p) => { if (areas.indexOf(p.area) < 0) areas.push(p.area); });
    order = [];
    let cur = origin;
    const leftAreas = areas.slice();
    while (leftAreas.length) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < leftAreas.length; i += 1) {
        const pts = places.filter((p) => p.area === leftAreas[i] && order.indexOf(p) < 0);
        let d = Infinity;
        for (let k = 0; k < pts.length; k += 1) d = Math.min(d, roadDistance(cur, pts[k]));
        if (d < bd) { bd = d; bi = i; }
      }
      const area = leftAreas.splice(bi, 1)[0];
      const pts = places.filter((p) => p.area === area && order.indexOf(p) < 0);
      const sub = greedyOrder(pts, cur, null);
      sub.forEach((p) => { order.push(p); cur = p; });
    }
    return order;
  }
  if (v === 1) {
    let fi = 0;
    let fd = -1;
    places.forEach((p, i) => {
      const d = roadDistance(origin, p);
      if (d > fd) { fd = d; fi = i; }
    });
    order = greedyOrder(places, origin, fi);
  } else {
    order = greedyOrder(places, origin, null);
  }
  // 省力/省钱策略下同样用总里程做 2-opt（少绕路 = 少折腾 / 少车费）
  return twoOpt(order, origin);
}

/* ============ 5. 饭点插入（brief 5.2：饭点必须安排 food） ============ */

/** 预演一遍到达/离开时间（不处理营业时间和告警，只用来决定饭点插谁） */
function previewArrivals(order, origin, opts) {
  const people = Math.max(1, Number(opts.people) || 2);
  let t = toMin(opts.startTime || '09:00');
  let prev = origin;
  return order.map((place) => {
    const km = prev === place ? 0 : roadDistance(prev, place);
    let travelMin = 0;
    if (km > 0.05) {
      const mode = pickMode(km, opts.budget, opts.strategy);
      travelMin = travelInfo(km, mode, people).minutes;
    }
    t += travelMin;
    const arrive = t;
    t += place.visitMin;
    prev = place;
    return { place, arrive, leave: t };
  });
}

/**
 * 饭点优先插 food：如果某个饭点没有饭店覆盖，
 * 就把顺序里「饭点开始之后」的第一个饭店提前到该位置，避免饭点赶路。
 */
function adjustForMeals(order, origin, opts) {
  if (order.length < 2) return order.slice();
  const startMin = toMin(opts.startTime || '09:00');
  const endMin = toMin(opts.endTime || '20:00');
  const seq = order.slice();
  CFG.meals.forEach((meal) => {
    // 端点也算饭点（N4：11:30 / 13:30 / 17:30 / 19:30 都按饭点处理）
    if (!(meal.start >= startMin && meal.start <= endMin)) return;
    const rows = previewArrivals(seq, origin, opts);
    const covered = rows.some((r) => r.place.category === 'food' && r.arrive <= meal.end && r.leave >= meal.start);
    if (covered) return;
    let target = -1;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].arrive >= meal.start) { target = i; break; }
    }
    if (target < 0) return;
    let foodIdx = -1;
    for (let i = target; i < seq.length; i += 1) {
      if (seq[i].category === 'food') { foodIdx = i; break; }
    }
    if (foodIdx < 0) return;
    const food = seq.splice(foodIdx, 1)[0];
    seq.splice(Math.min(target, seq.length), 0, food);
  });
  return seq;
}

/* ============ 6. 时间轴排程 + 告警（brief 5.2 / 5.3） ============ */

/**
 * 把顺序展开成时间轴行：
 *  { time(到达–离开), place, mode, travelMin, segCost, cumCost, cumFatigue, ... }
 * 同时产出四类提示：营业时间 / 饭点 / 时间不足 / 双校区。
 */
function schedule(order, origin, opts) {
  const people = Math.max(1, Number(opts.people) || 2);
  const budget = opts.budget === 'comfort' ? 'comfort' : 'economy';
  const strategy = opts.strategy || 'balanced';
  const startMin = toMin(opts.startTime || '09:00');
  const endMin = toMin(opts.endTime || '20:00');
  // 未选日期时不判断「周几闭馆」（避免「日期未选」却报周一闭馆）
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || ''));
  const weekday = parseDate(opts.date).getDay();
  const rows = [];
  const warnings = [];
  const skipped = [];
  let t = startMin;
  let prev = origin;
  let cumCost = 0;
  let cumFatigue = 0;
  let totalKm = 0;

  order.forEach((place) => {
    // 1) 固定闭馆日（如陕历博周一）：整站跳过，不计门票/里程/疲劳
    if (hasDate && place.closedDays && place.closedDays.indexOf(weekday) >= 0) {
      skipped.push(place.id);
      warnings.push({
        type: 'closed',
        text: '「' + place.name + '」' + WEEKDAY_NAMES[weekday] + '闭馆（约），已跳过：不安排入内、不计门票/里程/疲劳。'
      });
      return;
    }
    const km = prev === place ? 0 : roadDistance(prev, place);
    let mode = 'start';
    let travelMin = 0;
    let segCost = 0;
    let segFatigue = 0;
    let recommended = null;
    let reason = '';
    let overridden = false;
    if (km > 0.05) {
      // 用户手动指定方式：键支持 "fromId->toId"，也兼容只写 fromId（v1.2 新增）
      const ov = opts.modeOverrides || {};
      const ovKey = prev.id + '->' + place.id;
      let chosen = ov[ovKey] || ov[prev.id] || '';
      // B5：长距离 / 双校区段禁止步行（overrides 也要校验，违规回退推荐方式）
      const campusPair = (prev.id === 'xingqing' && place.id === 'innovation') ||
        (prev.id === 'innovation' && place.id === 'xingqing');
      if (chosen === 'walk' && (km > 2 || campusPair)) {
        const fallback = pickMode(km, budget, strategy);
        warnings.push({
          type: 'walk-blocked',
          text: '该段约 ' + km.toFixed(1) + ' km，不能步行，已恢复推荐方式（' + MODE_LABEL[fallback] + '）。'
        });
        chosen = '';
      }
      if (chosen && MODE_LABEL[chosen] && chosen !== 'start' && chosen !== 'recommend') {
        mode = chosen;
        overridden = true;
      } else {
        mode = pickMode(km, budget, strategy);
      }
      const info = travelInfo(km, mode, people);
      travelMin = info.minutes;
      segCost = info.cost;
      segFatigue = info.fatigue;
      const rec = recommendLeg(km, budget, strategy, people);
      recommended = rec.mode;
      reason = rec.reason;
    }
    // 2) 营业时间：到达早于开门可以等开门；但离开超过闭馆（或到得太晚）就整站跳过
    let arrive = t + travelMin;
    let waitMin = 0;
    if (place.open && place.close) {
      const openMin = toMin(place.open);
      const closeMin = toMin(place.close);
      if (arrive < openMin) {
        waitMin = openMin - arrive;
        arrive = openMin;
      }
      if (arrive > closeMin || arrive + place.visitMin > closeMin) {
        skipped.push(place.id);
        // P4：区分「营业时间不符」与「自选步行太远导致到得太晚」
        const tooFar = mode === 'walk' && km > 2;
        warnings.push({
          type: 'closed',
          text: tooFar
            ? '「' + place.name + '」步行约 ' + km.toFixed(1) + ' km 太远、到得太晚（营业约 ' + place.open + '–' + place.close + '），时间不足，已跳过：不安排入内、不计门票/里程/疲劳。'
            : '「' + place.name + '」此时段未营业（约 ' + place.open + '–' + place.close + '），已跳过：不安排入内、不计门票/里程/疲劳。'
        });
        return;
      }
    }
    const leave = arrive + place.visitMin;
    // 3) 只有真正成行的站才计入时间/预算/里程/疲劳
    t = leave;
    totalKm += km;
    cumCost += segCost;
    cumFatigue += segFatigue + place.fatigue;
    rows.push({
      place,
      fromId: prev.id,
      fromName: prev.name,
      fromLat: prev.lat,
      fromLng: prev.lng,
      mode,
      recommended,
      reason,
      overridden,
      travelMin,
      waitMin,
      segCost,
      km,
      arrive,
      leave,
      cumCost: Math.round(cumCost),
      cumFatigue: Math.round(cumFatigue * 10) / 10,
      late: false,
      closed: false
    });
    prev = place;
    if (waitMin > 0) {
      warnings.push({
        type: 'wait',
        text: '到得比开门早，在「' + place.name + '」等了 ' + waitMin + ' 分钟（约 ' + place.open + ' 开门）。'
      });
    }
  });

  const tripEnd = rows.length ? rows[rows.length - 1].leave : startMin;
  if (!rows.length) {
    // 全部地点都被跳过：预算/里程/疲劳都为 0，只保留跳过原因
    return { rows, warnings, skipped, totalKm: 0, fatigue: 0 };
  }

  // 6.1 时间不足：任何一站的离开时间超过结束时间
  const lateRows = rows.filter((r) => r.leave > endMin);
  if (lateRows.length) {
    const first = lateRows[0];
    warnings.push({
      type: 'time',
      text: '当天时间不足：排到「' + first.place.name + '」就会超过 ' + (opts.endTime || '20:00') +
        '，建议删掉「' + first.place.name + '」或改成两天。'
    });
    lateRows.forEach((r) => { r.late = true; });
  }

  // 6.2 营业时间 / 固定闭馆日：已在排程时处理（不满足条件的站直接跳过，不进时间轴）

  // 6.3 饭点：11:30–13:30 / 17:30–19:30 必须安排饭店
  const foodRows = rows.filter((r) => r.place.category === 'food');
  const mealWindows = CFG.meals.filter((m) => m.end >= startMin && m.start <= Math.min(endMin, tripEnd));
  if (!foodRows.length) {
    warnings.push({
      type: 'meal',
      text: '饭点还没有安排饭店：建议安排一家饭店（午饭 11:30–13:30 / 晚饭 17:30–19:30），不然只能路边随便吃。'
    });
  } else {
    mealWindows.forEach((m) => {
      const covered = foodRows.some((r) => r.arrive <= m.end && r.leave >= m.start);
      if (!covered) {
        warnings.push({
          type: 'meal',
          text: m.label + '饭点（' + toHHMM(m.start) + '–' + toHHMM(m.end) + '）没有安排饭店，建议把「' + foodRows[0].place.name + '」挪到饭点附近。'
        });
      }
    });
  }

  // 6.4 双校区：兴庆 ↔ 创新港 约 30–40 km，必须地铁/打车，禁止步行
  const visitedIds = rows.map((r) => r.place.id);
  if (visitedIds.indexOf(origin.id) < 0) visitedIds.push(origin.id);
  if (visitedIds.indexOf('xingqing') >= 0 && visitedIds.indexOf('innovation') >= 0) {
    const xq = findPlace('xingqing');
    const cg = findPlace('innovation');
    const campusKm = xq && cg ? roadDistance(xq, cg) : 0;
    const legs = rows.filter((r) =>
      (r.fromId === 'xingqing' && r.place.id === 'innovation') ||
      (r.fromId === 'innovation' && r.place.id === 'xingqing'));
    let leg = legs[0];
    if (!leg) {
      // 起点是其中一个校区时，取「到达另一个校区」的那一段
      const otherCampus = origin.id === 'xingqing' ? 'innovation'
        : (origin.id === 'innovation' ? 'xingqing' : null);
      if (otherCampus) leg = rows.filter((r) => r.place.id === otherCampus)[0];
    }
    if (!leg) {
      leg = rows.filter((r) => r.mode !== 'start' &&
        (r.place.id === 'xingqing' || r.place.id === 'innovation'))[0];
    }
    const legText = leg
      ? MODE_LABEL[leg.mode] + '约 ' + leg.travelMin + ' 分钟'
      : '地铁或打车';
    warnings.push({
      type: 'campus',
      text: '兴庆校区 ↔ 创新港 约' + Math.round(campusKm) + 'km（约30–40km），必须坐地铁或打车、不能步行；该段' + legText + '，单程记得留足时间。'
    });
  }

  // 6.5 远点提醒（兵马俑）
  if (visitedIds.indexOf('bingmayong') >= 0) {
    warnings.push({
      type: 'far',
      text: '兵马俑距市区约 40–50 km，单程约 1.5 小时，当天来回会很赶，建议单独安排半天或改成两天。'
    });
  }

  // 6.6 疲劳：偏累及以上提示
  const fatigue = Math.round(cumFatigue * 10) / 10;
  const level = fatigueLevel(fatigue);
  if (fatigue >= 16) {
    warnings.push({
      type: 'fatigue',
      text: '总疲劳 ' + fatigue + '（' + level + '），建议减少 1–2 个地点，或在中间安排休息。'
    });
  }

  return { rows, warnings, skipped, totalKm, fatigue };
}

/** 在数据里按 id 找地点（找不到返回 null）；兼容旧 id（如 shaanxilishi → shaanxi-history） */
const ID_ALIASES = { shaanxilishi: 'shaanxi-history' };

function findPlace(id) {
  const key = String(id);
  for (let i = 0; i < PLACES_DATA.length; i += 1) {
    if (PLACES_DATA[i].id === key) return PLACES_DATA[i];
  }
  if (ID_ALIASES[key]) return findPlace(ID_ALIASES[key]);
  return null;
}

/** 起点：默认兴庆校区；自定义时取选中的地点 */
function resolveOrigin(opts) {
  const id = opts.originId || CFG.defaults.originId;
  const p = findPlace(id) || findPlace(CFG.defaults.originId) || PLACES_DATA[0] || { id: 'origin', name: '起点', lat: 34.245, lng: 108.983 };
  return { id: p.id, name: p.name, lat: p.lat, lng: p.lng, category: p.category, area: p.area };
}

/* ============ 7. 预算与疲劳（brief 5.3 / 5.4） ============ */

/**
 * 预算分项：门票 + 餐饮 + 交通。
 * 门票/餐饮 = 单价 × 人数；交通 = 每段已算好的全队费用。
 * 返回的 total 由三项相加得到，保证「分项合计 = 总额」。
 */
function computeBudget(rows, people) {
  const p = Math.max(1, Math.round(Number(people) || 1));
  let tickets = 0;
  let food = 0;
  let transport = 0;
  rows.forEach((r) => {
    const unit = Number(r.place.cost) || 0;
    if (r.place.category === 'food') food += unit * p;
    else tickets += unit * p;
    transport += Number(r.segCost) || 0;
  });
  tickets = Math.round(tickets);
  food = Math.round(food);
  transport = Math.round(transport);
  return { tickets, food, transport, total: tickets + food + transport };
}

/** 疲劳总分 → 等级：0–8 轻松 / 9–15 适中 / 16–24 偏累 / >24 很累 */
function fatigueLevel(total) {
  const t = Number(total) || 0;
  for (let i = 0; i < CFG.fatigueBands.length; i += 1) {
    if (t <= CFG.fatigueBands[i].max) return CFG.fatigueBands[i].label;
  }
  return CFG.fatigueBands[CFG.fatigueBands.length - 1].label;
}

/* ============ 8. 主入口：buildPlan ============ */

/**
 * 生成一份完整行程。
 * @param {string[]} selectedIds 勾选的地点 id
 * @param {object} options originId/date/startTime/endTime/budget/people/strategy/variant
 * @returns {{rows:Array, warnings:Array, origin:object, opts:object, summary:object}}
 */
function buildPlan(selectedIds, options) {
  const opts = Object.assign({}, CFG.defaults, options || {});
  opts.people = Math.max(1, Math.min(9, Math.round(Number(opts.people) || 2)));
  opts.strategy = opts.strategy || 'balanced';
  opts.variant = Number(opts.variant) || 0;

  const picked = [];
  const seen = {};
  (Array.isArray(selectedIds) ? selectedIds : []).forEach((id) => {
    if (seen[id]) return;
    seen[id] = true;
    const p = findPlace(id);
    if (p) picked.push(p);
  });

  const origin = resolveOrigin(opts);
  const emptySummary = {
    budget: { tickets: 0, food: 0, transport: 0, total: 0 },
    totalMin: 0,
    totalKm: 0,
    fatigue: 0,
    fatigueLevel: fatigueLevel(0),
    startTime: opts.startTime,
    endTime: opts.endTime,
    arriveBack: opts.startTime
  };

  if (!picked.length) {
    return {
      rows: [],
      warnings: [{ type: 'empty', text: '还没有勾选地点：先在下面点几个想去的地方，再点「一键生成行程」。' }],
      origin,
      opts,
      summary: emptySummary
    };
  }

  // E11：时间参数校验（逻辑层也拦一层，避免生成负时长/跨天乱排）
  if (toMin(opts.endTime) <= toMin(opts.startTime)) {
    return {
      rows: [],
      warnings: [{ type: 'invalid-time', text: '时间设置无效：结束时间要晚于开始时间，请调整后再生成。' }],
      skipped: [],
      origin,
      opts,
      summary: emptySummary
    };
  }

  // 如果起点本身也被勾选，把它作为第一站，避免再绕回来
  const originPlace = picked.filter((p) => p.id === origin.id)[0] || null;
  const rest = picked.filter((p) => p !== originPlace);

  // 排序：对 0/1/2 三种候选顺序按总里程取优，保证「重新生成」不会明显变差（N2）
  let orderedRest = [];
  if (rest.length) {
    const cands = [0, 1, 2].map((v) => orderPlaces(rest, origin, opts.strategy, v));
    let best = cands[0];
    let bestD = tourDistance(best, origin);
    for (let i = 1; i < cands.length; i += 1) {
      const d = tourDistance(cands[i], origin);
      if (d < bestD - 1e-6) { best = cands[i]; bestD = d; }
    }
    // 想换方案时优先用本轮 variant 的候选，但只允许比最优多 2% 以内
    const req = cands[Math.min(2, Math.max(0, opts.variant))] || best;
    const reqD = tourDistance(req, origin);
    orderedRest = (reqD <= bestD * 1.02 + 0.01) ? req : best;
  }
  let order = originPlace ? [originPlace].concat(orderedRest) : orderedRest;

  order = adjustForMeals(order, origin, opts);
  const sched = schedule(order, origin, opts);
  const budget = computeBudget(sched.rows, opts.people);
  const last = sched.rows[sched.rows.length - 1];
  const summary = {
    budget,
    totalMin: last ? last.leave - toMin(opts.startTime) : 0,
    totalKm: Math.round(sched.totalKm * 10) / 10,
    fatigue: sched.fatigue,
    fatigueLevel: fatigueLevel(sched.fatigue),
    startTime: opts.startTime,
    endTime: opts.endTime,
    arriveBack: last ? fmtClock(last.leave) : opts.startTime,
    skipped: sched.skipped.slice()
  };

  // N2：切换「更省钱」时给出可感知对比（省钱或明示已是最省）
  const planWarnings = sched.warnings;
  // P7：方式自选跨方案保留，并明确告知生效/失效段数（配合结果区「恢复推荐方式」按钮）
  const requestedOverrides = Object.keys(opts.modeOverrides || {}).length;
  const appliedOverrides = sched.rows.filter((r) => r.overridden).length;
  if (requestedOverrides > 0) {
    planWarnings.push({
      type: 'info',
      text: appliedOverrides === requestedOverrides
        ? '已按你的自选方式计算 ' + appliedOverrides + ' 段；切换方案/重新生成会保留这些选择。'
        : '自选方式 ' + appliedOverrides + ' 段生效，' + (requestedOverrides - appliedOverrides) + ' 段因顺序变化或跳过已失效（可点「恢复推荐方式」）。'
    });
  }
  if (opts.strategy === 'less-money') {
    const baseline = buildPlan(selectedIds, Object.assign({}, opts, { strategy: 'balanced' }));
    const saved = baseline.summary.budget.total - summary.budget.total;
    if (saved > 0) {
      planWarnings.push({
        type: 'info',
        text: '更省钱方案：优先公交/步行，比标准方案省约 ¥' + saved + '，但路上时间会更长。'
      });
    } else {
      planWarnings.push({
        type: 'info',
        text: '当前已经是最省方案：交通已按公交/地铁/步行估算，更省钱不会再降。'
      });
    }
  }

  return { rows: sched.rows, warnings: planWarnings, skipped: sched.skipped, origin, opts, summary };
}

/* =====================================================================
 * 9. 页面交互（只在浏览器执行；Node require 时整段被 typeof document 保护）
 * ===================================================================== */

const CATS = [
  { id: 'all', name: '全部', emoji: '🧭' },
  { id: 'sight', name: '景点', emoji: '🏯' },
  { id: 'food', name: '饭店', emoji: '🍜' },
  { id: 'campus', name: '校园地标', emoji: '🎓' },
  { id: 'hub', name: '交通集散', emoji: '🚉' }
];

const CAT_EMOJI = { sight: '🏯', food: '🍜', campus: '🎓', hub: '🚉' };
const WARN_ICON = {
  time: '⏰', closed: '🚪', meal: '🍚', campus: '🚇', far: '🚌',
  fatigue: '😮‍💨', empty: '📍', wait: '⏳', info: 'ℹ️', 'invalid-time': '⚠️'
};

/** 简单 HTML 转义（所有数据都先转义再拼进 innerHTML） */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function money(n) {
  const v = Number(n) || 0;
  return v === 0 ? '免费' : '约 ¥' + v; // N5：所有价格展示标「约」
}

function initApp() {
  const els = {
    dateInput: document.getElementById('dateInput'),
    startTime: document.getElementById('startTime'),
    endTime: document.getElementById('endTime'),
    peopleVal: document.getElementById('peopleVal'),
    peopleMinus: document.getElementById('peopleMinus'),
    peoplePlus: document.getElementById('peoplePlus'),
    customOrigin: document.getElementById('customOrigin'),
    catTabs: document.getElementById('catTabs'),
    areaChips: document.getElementById('areaChips'),
    placeGrid: document.getElementById('placeGrid'),
    selectedCount: document.getElementById('selectedCount'),
    totalCount: document.getElementById('totalCount'),
    btnSelectAll: document.getElementById('btnSelectAll'),
    btnClearAll: document.getElementById('btnClearAll'),
    btnGenerate: document.getElementById('btnGenerate'),
    strategyBar: document.getElementById('strategyBar'),
    budgetSeg: document.getElementById('budgetSeg'),
    summary: document.getElementById('summary'),
    warnList: document.getElementById('warnList'),
    timeline: document.getElementById('timeline'),
    resultSection: document.getElementById('resultSection'),
    statusLive: document.getElementById('statusLive'),
    btnCopy: document.getElementById('btnCopy'),
    btnExport: document.getElementById('btnExport'),
    btnRegen: document.getElementById('btnRegen'),
    btnResetModes: document.getElementById('btnResetModes'),
    offlineMode: document.getElementById('offlineMode'),
    map: document.getElementById('map'),
    mapNote: document.getElementById('mapNote'),
    toast: document.getElementById('toast')
  };

  const PREF_KEY = 'xian-trip-prefs';

  /* ---------- 地图（本地 vendor Leaflet + OSM 瓦片）与高德换乘 ---------- */
  const MODE_SELECT_OPTIONS = [['', '推荐'], ['walk', '步行'], ['bus', '公交'], ['metro', '地铁'], ['taxi', '打车']];
  const amapCache = {};
  const amapFailCache = {};
  let amapSeq = 0;
  let mapObj = null;
  let mapLayer = null;

  function showMapNote(msg) {
    if (!els.mapNote) return;
    els.mapNote.textContent = msg;
    els.mapNote.classList.remove('hidden');
  }

  function ensureMap() {
    if (state.offline) {
      if (mapObj) { mapObj.remove(); mapObj = null; mapLayer = null; }
      showMapNote('离线模式：地图与换乘已关闭');
      return false;
    }
    if (mapObj) return true;
    if (typeof L === 'undefined') {
      showMapNote('地图组件未加载（vendor/leaflet 缺失），行程仍可用');
      return false;
    }
    mapObj = L.map(els.map, { zoomControl: true, attributionControl: true });
    // 底图：国内默认高德（中文路名/建筑轮廓，国内访问稳定）；可切换卫星看真实建筑；OSM 作为备选。
    // 地图属于「联网增强」，离线/失败时降级提示，不声称全站离线（B6 口径）
    const amapVec = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 19,
      attribution: '&copy; 高德地图'
    });
    const amapSat = L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 19,
      attribution: '&copy; 高德地图'
    });
    const osmTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    });
    amapVec.addTo(mapObj);
    let tileErrors = 0;
    [amapVec, amapSat, osmTiles].forEach((layer) => {
      layer.on('tileerror', () => {
        tileErrors += 1;
        if (tileErrors >= 3) showMapNote('底图瓦片加载失败：可右上角切换「高德卫星」/检查网络，行程仍可用');
      });
      layer.on('load', () => {
        if (tileErrors === 0 && els.mapNote) els.mapNote.classList.add('hidden');
      });
    });
    window.setTimeout(() => {
      if (tileErrors > 0 && els.mapNote && els.mapNote.classList.contains('hidden')) {
        showMapNote('地图底图加载较慢：可右上角切换「高德卫星」，行程仍可用');
      }
    }, 4000);
    L.control.layers(
      { '高德地图（含建筑轮廓）': amapVec, '高德卫星（看建筑）': amapSat, 'OpenStreetMap（可能较慢）': osmTiles },
      null,
      { position: 'topright', collapsed: true }
    ).addTo(mapObj);
    mapLayer = L.layerGroup().addTo(mapObj);
    return true;
  }

  function pinIcon(color, text) {
    return L.divIcon({
      className: 'map-pin',
      html: '<span class="map-pin-num" style="background:' + color + '">' + text + '</span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14]
    });
  }

  /** 把行程画到地图：起点 + 各站编号 marker、按方式着色的折线、popup */
  function renderMap(plan) {
    if (!ensureMap()) return;
    mapLayer.clearLayers();
    const points = [];
    const originLL = [plan.origin.lat, plan.origin.lng];
    L.marker(originLL, { icon: pinIcon('#6d4c41', '起') }).addTo(mapLayer)
      .bindPopup('<b>' + esc(plan.origin.name) + '</b><br>出发 ' + esc(plan.opts.startTime));
    points.push(originLL);
    let prev = originLL;
    plan.rows.forEach((r, i) => {
      const ll = [r.place.lat, r.place.lng];
      const color = MODE_COLOR[r.mode] || '#555';
      L.polyline([prev, ll], { color: color, weight: 4, opacity: 0.85 }).addTo(mapLayer);
      L.marker(ll, { icon: pinIcon(color, String(i + 1)) }).addTo(mapLayer)
        .bindPopup('<b>' + esc(r.place.name) + '</b><br>' + esc(fmtClock(r.arrive)) + '–' + esc(fmtClock(r.leave)) +
          '<br>' + esc(MODE_LABEL[r.mode] || r.mode) + ' · 约¥' + r.segCost + ' · 停留 ' + r.place.visitMin + ' 分');
      points.push(ll);
      prev = ll;
    });
    if (points.length > 1) {
      mapObj.fitBounds(L.latLngBounds(points), { padding: [26, 26] });
    } else {
      mapObj.setView(points[0], 13);
    }
    window.setTimeout(() => { if (mapObj) mapObj.invalidateSize(); }, 80);
  }

  function amapKey() {
    try { return window.localStorage.getItem('xian-trip-amap-key') || AMAP_KEY; } catch (e) { return AMAP_KEY; }
  }

  // amapLinkMode / amapLinkLabel / amapDeepLink 已提到文件顶部（纯函数，Node 可测）

  /** 解析高德公交换乘 JSON 的第一方案（只渲染接口真实返回的线路，不编造） */
  function parseAmapTransit(data) {
    try {
      const t = data && data.route && data.route.transits && data.route.transits[0];
      if (!t) return null;
      const lines = [];
      (t.segments || []).forEach((seg) => {
        const bus = seg.bus && seg.bus.buslines && seg.bus.buslines[0];
        if (!bus) return;
        const name = String(bus.name || '').split('(')[0].trim();
        if (!name) return; // 空线路名直接跳过，不拼造「XX路」
        const dep = (bus.departure_stop && bus.departure_stop.name) || '';
        const arr = (bus.arrival_stop && bus.arrival_stop.name) || '';
        lines.push(name + '：' + dep + '上→' + arr + '下（' + (Number(bus.via_num) || 0) + ' 站）');
      });
      if (!lines.length) return null;
      return { lines, minutes: Math.round(Number(t.duration) / 60) || 0 };
    } catch (e) {
      return null;
    }
  }

  /** JSONP 懒加载某段换乘详情：成功缓存 + 失败短缓存(60s) + 8s 超时 + 清理 script 节点 */
  function loadTransitDetail(r, onDone) {
    const key = r.fromId + '->' + r.place.id;
    if (amapCache[key]) { onDone(amapCache[key]); return; }
    const failAt = amapFailCache[key];
    if (failAt && Date.now() - failAt < 60000) { onDone(null); return; } // P8：失败短缓存，避免重复请求
    const ak = amapKey();
    if (!ak) { onDone(null); return; }
    amapSeq += 1;
    const cbName = '__dshAmapCb' + amapSeq;
    let finished = false;
    let scriptEl = null;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      try { delete window[cbName]; } catch (e) { /* ignore */ }
      if (scriptEl && scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
      if (val) amapCache[key] = val;
      else amapFailCache[key] = Date.now();
      onDone(val);
    };
    const timer = window.setTimeout(() => finish(null), 8000);
    window[cbName] = (data) => { window.clearTimeout(timer); finish(parseAmapTransit(data)); };
    scriptEl = document.createElement('script');
    scriptEl.src = 'https://restapi.amap.com/v3/direction/transit/integrated?origin=' +
      r.fromLng + ',' + r.fromLat + '&destination=' + r.place.lng + ',' + r.place.lat +
      '&city=029&strategy=0&output=json&key=' + encodeURIComponent(ak) + '&callback=' + cbName;
    scriptEl.onerror = () => { window.clearTimeout(timer); finish(null); };
    document.body.appendChild(scriptEl);
  }

  /** 有 Key 时给每段异步补换乘详情；没有 Key / 离线模式只保留深链，不阻塞时间轴 */
  function renderAmapDetails(plan) {
    if (state.offline || !amapKey() || !els.timeline) return;
    els.timeline.querySelectorAll('.amap-detail').forEach((el) => {
      const idx = Number(el.dataset.amap);
      const r = plan.rows[idx];
      if (!r || r.mode === 'start') return;
      if (r.mode !== 'bus' && r.mode !== 'metro') return; // 高德换乘详情只对公交/地铁段有意义
      loadTransitDetail(r, (detail) => {
        if (!detail) { el.textContent = '实时换乘获取失败，可点「高德」查看'; return; }
        el.textContent = '换乘：' + detail.lines.join(' → ') + (detail.minutes ? '（约 ' + detail.minutes + ' 分钟）' : '');
      });
    });
  }

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREF_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch (e) {
      return {};
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify({
        selected: Array.from(state.selected),
        originId: state.originId,
        budget: state.budget,
        people: state.people,
        strategy: state.strategy
      }));
    } catch (e) {
      /* file:// 或隐私模式下 localStorage 可能不可用，忽略即可 */
    }
  }

  const OFFLINE_KEY = 'xian-trip-offline';
  function loadOffline() {
    try { return window.localStorage.getItem(OFFLINE_KEY) === '1'; } catch (e) { return false; }
  }
  function saveOffline() {
    try { window.localStorage.setItem(OFFLINE_KEY, state.offline ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  const prefs = loadPrefs();
  const allAreas = [];
  PLACES_DATA.forEach((p) => { if (allAreas.indexOf(p.area) < 0) allAreas.push(p.area); });

  const state = {
    cat: 'all',
    area: 'all',
    selected: new Set(),
    originId: prefs.originId || CFG.defaults.originId,
    budget: prefs.budget || CFG.defaults.budget,
    people: Math.max(1, Math.min(9, Number(prefs.people) || CFG.defaults.people)),
    strategy: prefs.strategy || CFG.defaults.strategy,
    variant: 0,
    plan: null,
    modeOverrides: {},
    offline: loadOffline()
  };

  // 恢复上次勾选（只保留仍存在的地点 id）；用户清空过（selected=[]）就尊重空选择（N3）
  const preSelected = Array.isArray(prefs.selected) ? prefs.selected : CFG.preselected;
  preSelected.forEach((id) => { if (findPlace(id)) state.selected.add(id); });

  let toastTimer = null;
  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function setStatus(msg) {
    if (els.statusLive) els.statusLive.textContent = msg;
  }

  /* ---------- 渲染：分类 / 区域 / 卡片 ---------- */

  function visiblePlaces() {
    return PLACES_DATA.filter((p) =>
      (state.cat === 'all' || p.category === state.cat) &&
      (state.area === 'all' || p.area === state.area));
  }

  function renderTabs() {
    const html = CATS.map((c) => {
      const count = c.id === 'all'
        ? PLACES_DATA.length
        : PLACES_DATA.filter((p) => p.category === c.id).length;
      const on = state.cat === c.id ? ' on' : '';
      return '<button type="button" class="tab' + on + '" data-cat="' + c.id + '" aria-pressed="' + (state.cat === c.id) + '">' +
        '<span aria-hidden="true">' + c.emoji + '</span>' + esc(c.name) +
        '<span class="count">' + count + '</span></button>';
    }).join('');
    els.catTabs.innerHTML = html;
  }

  function renderAreas() {
    const list = ['all'].concat(allAreas);
    const html = list.map((a) => {
      const on = state.area === a ? ' on' : '';
      const label = a === 'all' ? '全部区域' : a;
      return '<button type="button" class="area' + on + '" data-area="' + esc(a) + '" aria-pressed="' + (state.area === a) + '">' + esc(label) + '</button>';
    }).join('');
    els.areaChips.innerHTML = html;
  }

  function placeCard(p) {
    const checked = state.selected.has(p.id);
    return '<label class="place' + (checked ? ' on' : '') + '">' +
      '<input type="checkbox" class="place-check" value="' + esc(p.id) + '"' + (checked ? ' checked' : '') + ' />' +
      '<span class="place-head">' +
      '<span class="place-emoji" aria-hidden="true">' + (CAT_EMOJI[p.category] || '📍') + '</span>' +
      '<span class="place-name">' + esc(p.name) + '</span>' +
      '</span>' +
      '<span class="place-tags">' + esc(CAT_LABEL[p.category] || p.category) + ' · ' + esc(p.area) + '</span>' +
      '<span class="place-intro">' + esc(p.intro) + '</span>' +
      '<span class="place-meta">' +
      '<span class="place-cost">' + money(p.cost) + (p.category === 'food' ? '/人' : '') + '</span>' +
      '<span>' + p.visitMin + ' 分钟</span>' +
      '<span class="stars" role="img" aria-label="劳累 ' + p.fatigue + '/5" title="劳累指数 ' + p.fatigue + '/5"><span aria-hidden="true">' + stars(p.fatigue) + '</span></span>' +
      '</span>' +
      '</label>';
  }

  function stars(n) {
    const v = Math.max(0, Math.min(5, Number(n) || 0));
    let s = '';
    for (let i = 0; i < 5; i += 1) s += i < v ? '★' : '☆';
    return s;
  }

  function renderPlaces() {
    const list = visiblePlaces();
    els.placeGrid.innerHTML = list.length ? list.map(placeCard).join('') : '<p class="empty-tip">这个筛选下还没有地点，换个分类或区域看看。</p>';
  }

  function updateCounts() {
    els.selectedCount.textContent = state.selected.size;
    els.totalCount.textContent = PLACES_DATA.length;
  }

  function renderAll() {
    renderTabs();
    renderAreas();
    renderPlaces();
    updateCounts();
    syncSettingsUI();
  }

  function syncSettingsUI() {
    els.dateInput.value = els.dateInput.value || todayISO();
    els.startTime.value = els.startTime.value || CFG.defaults.startTime;
    els.endTime.value = els.endTime.value || CFG.defaults.endTime;
    els.peopleVal.textContent = state.people;
    // 起点：三个标准选项直接对应；自定义时值为某个地点 id
    const isStandard = state.originId === 'xingqing' || state.originId === 'innovation' || state.originId === 'custom';
    const radioValue = isStandard ? state.originId : 'custom';
    els.customOrigin.classList.toggle('hidden', radioValue !== 'custom');
    const radios = document.querySelectorAll('input[name="origin"]');
    for (let i = 0; i < radios.length; i += 1) {
      radios[i].checked = (radios[i].value === radioValue);
    }
    if (!isStandard && findPlace(state.originId)) {
      els.customOrigin.value = state.originId;
    }
    const budgetBtns = els.budgetSeg.querySelectorAll('button');
    for (let i = 0; i < budgetBtns.length; i += 1) {
      const on = budgetBtns[i].dataset.budget === state.budget;
      budgetBtns[i].classList.toggle('on', on);
      budgetBtns[i].setAttribute('aria-pressed', String(on)); // N7
    }
    const stratBtns = els.strategyBar.querySelectorAll('button');
    for (let i = 0; i < stratBtns.length; i += 1) {
      const on = stratBtns[i].dataset.strategy === state.strategy;
      stratBtns[i].classList.toggle('on', on);
      stratBtns[i].setAttribute('aria-pressed', String(on)); // N7
    }
    if (els.offlineMode) els.offlineMode.checked = state.offline;
  }

  function todayISO() {
    const d = new Date();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /* ---------- 结果渲染 ---------- */

  function summaryHtml(plan) {
    const s = plan.summary;
    const b = s.budget;
    const mins = Math.max(0, s.totalMin);
    const dur = Math.floor(mins / 60) + ' 小时 ' + (mins % 60) + ' 分';
    return '<div class="sum-card">' +
      '<span class="sum-k">总预算（约）</span>' +
      '<strong class="sum-v">约 ¥' + b.total + '</strong>' +
      '<span class="sum-sub">门票 约¥' + b.tickets + ' + 餐饮 约¥' + b.food + ' + 交通 约¥' + b.transport + '</span>' +
      '</div>' +
      '<div class="sum-card">' +
      '<span class="sum-k">总时长</span>' +
      '<strong class="sum-v">' + dur + '</strong>' +
      '<span class="sum-sub">' + plan.opts.startTime + ' 出发 · ' + s.arriveBack + ' 结束</span>' +
      '</div>' +
      '<div class="sum-card">' +
      '<span class="sum-k">总里程</span>' +
      '<strong class="sum-v">' + s.totalKm + ' km</strong>' +
      '<span class="sum-sub">道路距离（直线 × ' + CFG.roadFactor + '）估算</span>' +
      '</div>' +
      '<div class="sum-card">' +
      '<span class="sum-k">疲劳等级</span>' +
      '<strong class="sum-v">' + s.fatigueLevel + '</strong>' +
      '<span class="sum-sub">' + s.fatigue + ' 分（0–8 轻松 / 9–15 适中 / 16–24 偏累 / &gt;24 很累）</span>' +
      '</div>' +
      '<p class="sum-meta">起点：' + esc(plan.origin.name) + ' · ' + esc(plan.opts.date || '日期未选') +
      ' · ' + plan.opts.people + ' 人 · ' + (plan.opts.budget === 'comfort' ? '舒适档' : '经济档') +
      ' · ' + (STRATEGY_LABEL[plan.opts.strategy] || '标准方案') +
      ' · 预算分项已校验：约¥' + b.tickets + ' + 约¥' + b.food + ' + 约¥' + b.transport + ' = 约¥' + b.total +
      '（价格均为约值，交通按 ' + plan.opts.people + ' 人计）</p>';
  }

  /** 每段「方式」下拉：推荐（空值）/步行/公交/地铁/打车；km>2 时段禁用步行（B5） */
  function modeSelectHtml(r) {
    if (r.mode === 'start') return '起点';
    const cur = r.overridden ? r.mode : '';
    const walkDisabled = r.km > 2;
    const opts = MODE_SELECT_OPTIONS.map((pair) => {
      const disabled = pair[0] === 'walk' && walkDisabled;
      return '<option value="' + pair[0] + '"' + (pair[0] === cur ? ' selected' : '') +
        (disabled ? ' disabled title="该段约 ' + r.km.toFixed(1) + ' km，不能步行"' : '') + '>' +
        pair[1] + (disabled ? '（太远）' : '') + '</option>';
    }).join('');
    return '<select class="mode-select" data-from="' + esc(r.fromId) + '" data-to="' + esc(r.place.id) +
      '" aria-label="本段出行方式（当前 ' + esc(MODE_LABEL[r.mode]) + '）">' + opts + '</select>';
  }

  function rowHtml(r, i) {
    const p = r.place;
    const cls = ['trow'];
    if (r.late) cls.push('late');
    if (r.closed) cls.push('closed');
    const isStart = r.mode === 'start';
    const timeText = fmtClock(r.arrive) + '–' + fmtClock(r.leave);
    const modeText = (isStart ? '起点' : MODE_LABEL[r.mode]) + (r.waitMin > 0 ? '（等开门 ' + r.waitMin + ' 分）' : '');
    const travelText = isStart ? '—' : r.travelMin + ' 分';
    const costText = isStart ? '—' : '约¥' + r.segCost;
    const recBadge = (r.recommended && !isStart)
      ? '<span class="rec-badge">推荐：' + MODE_LABEL[r.recommended] +
        (r.overridden && r.mode !== r.recommended ? '（当前：' + MODE_LABEL[r.mode] + '）' : '') + '</span>' +
        '<span class="rec-reason">' + esc(r.reason) + '</span>'
      : '';
    const amapHtml = isStart ? ''
      : '<a class="amap-link" href="' + esc(amapDeepLink(r)) + '" target="_blank" rel="noopener noreferrer">' + esc(amapLinkLabel(r.mode)) + '</a>' +
        '<span class="amap-detail" data-amap="' + i + '"></span>';
    // N7：div 版时间轴补 table 语义 + 每格 aria-label，读屏也能听懂 8 列
    return '<div class="' + cls.join(' ') + '" role="row">' +
      '<span class="tc" role="cell" data-label="时间" aria-label="时间 ' + timeText + '">' + timeText + '</span>' +
      '<span class="tp" role="cell" data-label="地点 · 分类" aria-label="地点 ' + esc(p.name) + '，' + esc(CAT_LABEL[p.category] || p.category) + '，' + esc(p.area) + '">' + esc(p.name) + '<em>' + esc(CAT_LABEL[p.category] || p.category) + ' · ' + esc(p.area) + '</em>' + recBadge + amapHtml + '</span>' +
      '<span role="cell" data-label="停留" aria-label="停留 ' + p.visitMin + ' 分钟">' + p.visitMin + ' 分</span>' +
      '<span role="cell" data-label="出行方式" aria-label="出行方式 ' + modeText + '">' + modeSelectHtml(r) + '</span>' +
      '<span role="cell" data-label="该段耗时" aria-label="该段耗时 ' + travelText + '">' + travelText + '</span>' +
      '<span role="cell" data-label="该段费用" aria-label="该段费用 ' + costText + '">' + costText + '</span>' +
      '<span role="cell" data-label="累计预算" aria-label="累计预算 约' + r.cumCost + ' 元">约¥' + r.cumCost + '</span>' +
      '<span role="cell" data-label="累计疲劳" aria-label="累计疲劳 ' + r.cumFatigue + '">' + r.cumFatigue + '</span>' +
      '</div>';
  }

  function renderResult(plan) {
    els.summary.innerHTML = summaryHtml(plan);
    els.warnList.innerHTML = plan.warnings.length
      ? plan.warnings.map((w) =>
        '<li class="warn ' + esc(w.type) + '"><span class="warn-ico" aria-hidden="true">' + (WARN_ICON[w.type] || 'ℹ️') + '</span><span>' + esc(w.text) + '</span></li>').join('')
      : '<li class="warn ok"><span class="warn-ico" aria-hidden="true">✅</span><span>没有发现冲突，这条行程可以直接出发。</span></li>';
    els.timeline.innerHTML = plan.rows.map((r, i) => rowHtml(r, i)).join('');
    els.resultSection.classList.remove('hidden');
    els.btnGenerate.textContent = '重新生成路线';
    renderMap(plan);
    renderAmapDetails(plan);
  }

  /* ---------- 复制文字 / 导出 PNG ---------- */

  function planToText(plan) {
    const s = plan.summary;
    const b = s.budget;
    const lines = [];
    lines.push('西安一日行程（' + (plan.opts.date || '日期未定') + ' · ' + plan.origin.name + '出发 ' +
      plan.opts.startTime + '–' + plan.opts.endTime + ' · ' + plan.opts.people + ' 人 · ' +
      (plan.opts.budget === 'comfort' ? '舒适' : '经济') + ' · ' + (STRATEGY_LABEL[plan.opts.strategy] || '标准方案') + '）');
    lines.push('');
    plan.rows.forEach((r, i) => {
      lines.push((i + 1) + '. ' + fmtClock(r.arrive) + '–' + fmtClock(r.leave) + ' ' + r.place.name +
        '（' + (CAT_LABEL[r.place.category] || r.place.category) + ' · ' + r.place.area + '）停留 ' + r.place.visitMin + ' 分钟');
      if (r.mode !== 'start') {
        lines.push('   交通：' + MODE_LABEL[r.mode] + ' ' + r.travelMin + ' 分钟 · ¥' + r.segCost +
          ' · 累计 ¥' + r.cumCost + ' · 累计疲劳 ' + r.cumFatigue);
      }
    });
    lines.push('');
    lines.push('预算（约值）：门票 约¥' + b.tickets + ' + 餐饮 约¥' + b.food + ' + 交通 约¥' + b.transport + ' = 约¥' + b.total + '（' + plan.opts.people + ' 人）');
    lines.push('总时长 ' + Math.floor(s.totalMin / 60) + ' 小时 ' + (s.totalMin % 60) + ' 分 · 总里程 ' + s.totalKm + ' km · 疲劳 ' + s.fatigueLevel + '（' + s.fatigue + ' 分）');
    if (plan.warnings.length) {
      lines.push('');
      lines.push('提示：');
      plan.warnings.forEach((w) => lines.push('- ' + w.text));
    }
    return lines.join('\n');
  }

  function copyText(text) {
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? '已复制行程文字' : '复制失败，请手动选择文字');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('已复制行程文字')).catch(fallback);
    } else {
      fallback();
    }
  }

  function clipText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    return s + '…';
  }

  function exportPng(plan) {
    if (!plan || !plan.rows.length) { toast('先生成行程再导出'); return; }
    const dpr = 2;
    const W = 920;
    const pad = 44;
    const rowH = 62;
    const warnList = plan.warnings.slice(0, 6);
    const warnH = 30;
    const headH = 190;
    const H = headH + plan.rows.length * rowH + warnList.length * warnH + 130;
    const cv = document.createElement('canvas');
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);

    const FONT = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';

    // 背景 + 顶栏
    ctx.fillStyle = '#fbf7ef';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#b3541e';
    ctx.fillRect(0, 0, W, 76);

    ctx.fillStyle = '#fffdf8';
    ctx.font = 'bold 30px ' + FONT;
    ctx.fillText('西安 · 一日行程', pad, 50);

    // 标题信息
    const s = plan.summary;
    ctx.fillStyle = '#2f2b28';
    ctx.font = 'bold 17px ' + FONT;
    ctx.fillText(plan.origin.name + '出发 · ' + (plan.opts.date || '日期未选') + ' · ' + plan.opts.startTime + '–' + plan.opts.endTime, pad, 112);
    ctx.fillStyle = '#7a6f66';
    ctx.font = '15px ' + FONT;
    ctx.fillText(plan.opts.people + ' 人 · ' + (plan.opts.budget === 'comfort' ? '舒适档' : '经济档') + ' · ' + (STRATEGY_LABEL[plan.opts.strategy] || '标准方案'), pad, 138);

    // 时间轴表头
    let y = 172;
    ctx.fillStyle = '#8c4a1f';
    ctx.font = 'bold 13px ' + FONT;
    ctx.fillText('时间', pad, y);
    ctx.fillText('地点 / 分类', pad + 175, y);
    ctx.fillText('方式', pad + 585, y);
    ctx.fillText('段耗时', pad + 660, y);
    ctx.fillText('累计花费', pad + 745, y);
    y += 14;

    // 时间轴
    plan.rows.forEach((r, i) => {
      const top = y + i * rowH;
      if (i % 2 === 0) {
        ctx.fillStyle = '#f3ead9';
        ctx.fillRect(pad - 14, top - 6, W - (pad - 14) * 2, rowH - 8);
      }
      ctx.fillStyle = r.late ? '#b3261e' : '#2f2b28';
      ctx.font = 'bold 17px ' + FONT;
      ctx.fillText(fmtClock(r.arrive) + '–' + fmtClock(r.leave), pad, top + 16);
      ctx.fillText(clipText(ctx, r.place.name, 380), pad + 175, top + 16);
      ctx.fillStyle = '#7a6f66';
      ctx.font = '14px ' + FONT;
      const modeText = r.mode === 'start' ? '起点' : MODE_LABEL[r.mode] + ' ' + r.travelMin + ' 分';
      ctx.fillText((CAT_LABEL[r.place.category] || r.place.category) + ' · 停留 ' + r.place.visitMin + ' 分 · ' + modeText +
        (r.mode === 'start' ? '' : ' · 约¥' + r.segCost), pad + 175, top + 40);
      ctx.fillStyle = '#8c4a1f';
      ctx.font = 'bold 15px ' + FONT;
      ctx.fillText('约¥' + r.cumCost, pad + 745, top + 20);
      ctx.fillStyle = '#7a6f66';
      ctx.font = '13px ' + FONT;
      ctx.fillText('累 ' + r.cumFatigue, pad + 745, top + 42);
    });

    // 汇总
    const sy = y + plan.rows.length * rowH + 24;
    ctx.fillStyle = '#2f2b28';
    ctx.font = 'bold 18px ' + FONT;
    ctx.fillText('预算（约值） 约¥' + s.budget.total + '（门票 约¥' + s.budget.tickets + ' + 餐饮 约¥' + s.budget.food + ' + 交通 约¥' + s.budget.transport + '）', pad, sy);
    ctx.fillStyle = '#7a6f66';
    ctx.font = '15px ' + FONT;
    ctx.fillText('总时长 ' + Math.floor(s.totalMin / 60) + ' 小时 ' + (s.totalMin % 60) + ' 分 · 总里程 ' + s.totalKm +
      ' km · 疲劳 ' + s.fatigueLevel + '（' + s.fatigue + ' 分）', pad, sy + 28);

    // 提示（最多 6 条）
    warnList.forEach((w, i) => {
      ctx.fillStyle = '#b3261e';
      ctx.font = '13px ' + FONT;
      ctx.fillText(clipText(ctx, '· ' + w.text, W - pad * 2), pad, sy + 62 + i * warnH);
    });

    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = '西安一日行程.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已导出 PNG 图片');
  }

  /* ---------- 生成与事件 ---------- */

  function readOptions() {
    const originId = state.originId === 'custom'
      ? (els.customOrigin.value || CFG.defaults.originId)
      : state.originId;
    return {
      originId,
      date: els.dateInput.value || '',
      startTime: els.startTime.value || CFG.defaults.startTime,
      endTime: els.endTime.value || CFG.defaults.endTime,
      budget: state.budget,
      people: state.people,
      strategy: state.strategy,
      variant: state.variant,
      modeOverrides: state.modeOverrides || {}
    };
  }

  function generate() {
    if (!state.selected.size) {
      setStatus('先勾选至少一个地点，再生成行程。');
      toast('还没选地点');
      return;
    }
    const opts = readOptions();
    if (toMin(opts.endTime) <= toMin(opts.startTime)) {
      setStatus('结束时间要晚于开始时间，检查一下～');
      return;
    }
    els.btnGenerate.disabled = true;
    setStatus('正在规划路线…');
    window.setTimeout(() => {
      const plan = buildPlan(Array.from(state.selected), opts);
      state.plan = plan;
      renderResult(plan);
      els.btnGenerate.disabled = false;
      setStatus('已生成 ' + plan.rows.length + ' 站 · 总里程 ' + plan.summary.totalKm + ' km · 总预算 ¥' + plan.summary.budget.total);
      savePrefs();
      if (plan.rows.length && els.resultSection.scrollIntoView) {
        els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 180);
  }

  // 分类 tab
  els.catTabs.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.tab') : null;
    if (!btn) return;
    state.cat = btn.dataset.cat;
    renderTabs();
    renderPlaces();
  });

  // 区域 chips
  els.areaChips.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.area') : null;
    if (!btn) return;
    state.area = btn.dataset.area;
    renderAreas();
    renderPlaces();
  });

  // 勾选地点（事件委托）
  els.placeGrid.addEventListener('change', (e) => {
    const input = e.target;
    if (!input || !input.classList || !input.classList.contains('place-check')) return;
    if (input.checked) state.selected.add(input.value);
    else state.selected.delete(input.value);
    const label = input.closest('.place');
    if (label) label.classList.toggle('on', input.checked);
    updateCounts();
    savePrefs();
    if (state.plan) setStatus('选择已更新，点「重新生成路线」刷新行程。');
  });

  // 全选当前筛选 / 清空
  els.btnSelectAll.addEventListener('click', () => {
    visiblePlaces().forEach((p) => state.selected.add(p.id));
    renderPlaces();
    updateCounts();
    savePrefs();
    toast('已选中当前筛选下的 ' + visiblePlaces().length + ' 个地点');
  });

  els.btnClearAll.addEventListener('click', () => {
    state.selected.clear();
    renderPlaces();
    updateCounts();
    savePrefs();
    toast('已清空全部选择');
  });

  // 起点
  const originRadios = document.querySelectorAll('input[name="origin"]');
  for (let i = 0; i < originRadios.length; i += 1) {
    originRadios[i].addEventListener('change', (e) => {
      state.originId = e.target.value;
      els.customOrigin.classList.toggle('hidden', state.originId !== 'custom');
      if (state.originId === 'custom') {
        els.customOrigin.value = els.customOrigin.value || 'zhonglou';
      }
      savePrefs();
    });
  }
  els.customOrigin.addEventListener('change', () => {
    state.originId = els.customOrigin.value || 'custom';
    savePrefs();
  });

  // 人数
  els.peopleMinus.addEventListener('click', () => {
    state.people = Math.max(1, state.people - 1);
    els.peopleVal.textContent = state.people;
    savePrefs();
  });
  els.peoplePlus.addEventListener('click', () => {
    state.people = Math.min(9, state.people + 1);
    els.peopleVal.textContent = state.people;
    savePrefs();
  });

  // 预算档位
  els.budgetSeg.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('button') : null;
    if (!btn || !btn.dataset.budget) return;
    state.budget = btn.dataset.budget;
    syncSettingsUI();
    savePrefs();
    if (state.selected.size) generate();
  });

  // 方案切换：更省力 / 更省钱
  els.strategyBar.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('button') : null;
    if (!btn || !btn.dataset.strategy) return;
    state.strategy = btn.dataset.strategy;
    syncSettingsUI();
    savePrefs();
    if (state.selected.size) generate();
  });

  // 生成 / 重新生成 / 复制 / 导出
  els.btnGenerate.addEventListener('click', generate);

  // 每段交通方式自选：改选后立即重算该段与全表累计、汇总、地图，不刷新页面
  els.timeline.addEventListener('change', (e) => {
    const sel = e.target;
    if (!sel || !sel.classList || !sel.classList.contains('mode-select')) return;
    if (!state.selected.size) return;
    state.modeOverrides = state.modeOverrides || {};
    const key = sel.dataset.from + '->' + sel.dataset.to;
    if (!sel.value) delete state.modeOverrides[key];
    else state.modeOverrides[key] = sel.value;
    const plan = buildPlan(Array.from(state.selected), readOptions());
    state.plan = plan;
    renderResult(plan);
    setStatus('已按自选方式重新计算 · 总预算约 ¥' + plan.summary.budget.total +
      ' · 总里程 ' + plan.summary.totalKm + ' km');
  });
  els.btnRegen.addEventListener('click', () => {
    state.variant = (state.variant + 1) % 3;
    generate();
  });
  // P7：一键恢复推荐方式
  if (els.btnResetModes) {
    els.btnResetModes.addEventListener('click', () => {
      state.modeOverrides = {};
      if (state.selected.size) {
        const plan = buildPlan(Array.from(state.selected), readOptions());
        state.plan = plan;
        renderResult(plan);
        setStatus('已恢复全部推荐方式 · 总预算约 ¥' + plan.summary.budget.total + '（约值）');
      }
    });
  }
  // B6：离线模式开关（关闭地图瓦片与高德请求；核心行程/预算/复制/PNG 仍可用）
  if (els.offlineMode) {
    els.offlineMode.addEventListener('change', () => {
      state.offline = !!els.offlineMode.checked;
      saveOffline();
      if (state.plan) {
        renderResult(state.plan);
        setStatus(state.offline ? '离线模式：地图与换乘已关闭，行程/预算仍可用' : '联网增强已开启：地图与高德换乘可用（需网络）');
      } else if (state.offline) {
        showMapNote('离线模式：地图与换乘已关闭');
      }
    });
  }
  els.btnCopy.addEventListener('click', () => {
    if (!state.plan) { toast('先生成行程'); return; }
    copyText(planToText(state.plan));
  });
  els.btnExport.addEventListener('click', () => exportPng(state.plan));

  // 初始化
  els.customOrigin.innerHTML = PLACES_DATA.map((p) =>
    '<option value="' + esc(p.id) + '">' + esc(p.name) + '（' + esc(CAT_LABEL[p.category] || p.category) + '）</option>').join('');
  els.customOrigin.value = 'zhonglou';
  els.dateInput.value = todayISO();
  state.originId = prefs.originId || CFG.defaults.originId;
  if (state.originId !== 'xingqing' && state.originId !== 'innovation' && state.originId !== 'custom') {
    // 自定义起点：值是地点 id
    els.customOrigin.value = state.originId;
  }
  renderAll();
  syncSettingsUI();
  setStatus('默认已选 4 个地点，点「一键生成行程」试试。');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}

/* ============ 10. Node 测试导出 ============ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    haversine,
    roadDistance,
    pickMode,
    travelInfo,
    recommendLeg,
    orderPlaces,
    tourDistance,
    twoOpt,
    previewArrivals,
    adjustForMeals,
    schedule,
    buildPlan,
    computeBudget,
    fatigueLevel,
    resolveOrigin,
    toMin,
    toHHMM,
    fmtClock,
    amapLinkMode,
    amapLinkLabel,
    amapDeepLink,
    findPlace,
    PLACES: PLACES_DATA,
    CFG,
    CATS,
    MODE_LABEL,
    CAT_LABEL
  };
}
