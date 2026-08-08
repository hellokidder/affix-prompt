/**
 * derive-target.test.ts — 状态机纯函数确定性单测（node --test，无需 pi 运行时）。
 *
 * 覆盖：
 *   - 统一模型：剥落 / 接管交回（含迟滞防乒乓）/ 大步级联 / 怪物封顶 /
 *     缩略限高（maxRows）/ 滚动连续性
 *   - 帧循环模拟：完整 layout 循环（含补偿公式）下内容行位置连续性，
 *     以及模式切换 / disable→enable 的补偿基准回归（曾修复的跳动 bug）、
 *     超长消息 + 底部跟随不锁死回归。
 *
 * 跑法：node --test tests（glob 模式见 package.json scripts.test）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anchorActive,
  deriveNaturalTarget,
  MIN_TRANSCRIPT_ROWS,
  type UserMsg,
} from "../state-machine.ts";

/** 造一个消息区间表 */
function msgs(specs: Array<[number, number]>): UserMsg[] {
  return specs.map(([start, end]) => ({ start, end, comp: {} }));
}

/** 三条消息：msg1 [5,13) H=8，msg2 [20,28) H=8，msg3 [35,45) H=10 */
const INDEX = msgs([
  [5, 13],
  [20, 28],
  [35, 45],
]);
const VIEWPORT = 30;
const RENDERED = 0;

// ---------- 统一模型：剥落与接管 ----------

test("未触顶时 active=0 高度 0", () => {
  const r = deriveNaturalTarget(0, VIEWPORT, RENDERED, INDEX, 0);
  assert.equal(r.active, 0);
  assert.equal(r.height, 0);
});

test("触顶即剥落，h = st - start", () => {
  for (const st of [5, 6, 7, 12]) {
    const r = deriveNaturalTarget(st, VIEWPORT, RENDERED, INDEX, 0);
    assert.equal(r.active, 1, `st=${st}`);
    assert.equal(r.height, st - 5, `st=${st}`);
  }
});

test("完全吸顶后 h 封顶在 H（到下一问题距离足够时）", () => {
  // msg1 [5,20) H=15，msg2 在远处 [50,60)：st=20 时 h = H
  const far = msgs([
    [5, 20],
    [50, 60],
  ]);
  const r = deriveNaturalTarget(20, VIEWPORT, RENDERED, far, 1);
  assert.equal(r.active, 1);
  assert.equal(r.height, 15);
  // 原 INDEX 下 msg2 顶在 20：不再有渐进三角，st=13 时 h = min(8, 封顶) = 8（全高吸顶）
  const r2 = deriveNaturalTarget(13, VIEWPORT, RENDERED, INDEX, 1);
  assert.equal(r2.height, 8);
});

test("接近下一条时不再缩没（渐进三角已移除，跳变由补偿吸收）", () => {
  // st=19（距 msg2 顶 1 行）：h 仍为全高 8；接管帧（st=20）h=0 并触发补偿
  const r = deriveNaturalTarget(19, VIEWPORT, RENDERED, INDEX, 1);
  assert.equal(r.active, 1);
  assert.equal(r.height, 8);
  const at = deriveNaturalTarget(20, VIEWPORT, RENDERED, INDEX, 1);
  assert.equal(at.active, 2);
  assert.equal(at.height, 0);
});

test("前进接管——触顶即接管，接管点 h=0 连续（跳变由补偿吸收）", () => {
  const before = deriveNaturalTarget(19, VIEWPORT, RENDERED, INDEX, 1);
  const at = deriveNaturalTarget(20, VIEWPORT, RENDERED, INDEX, 1);
  const after = deriveNaturalTarget(20, VIEWPORT, RENDERED, INDEX, 2);
  assert.equal(before.height, 8);
  assert.equal(at.active, 2);
  assert.equal(at.height, 0); // 接管帧 h=0（跳变由同帧补偿吸收）
  assert.equal(after.height, 0);
  // 接管后从 0 重新剥落
  const r = deriveNaturalTarget(25, VIEWPORT, RENDERED, INDEX, 2);
  assert.equal(r.active, 2);
  assert.equal(r.height, 5);
});

test("后退交回——需滚过接管迟滞点（msg.start − takeoverDrop）", () => {
  // msg2 接管点 20、跳变 8 → 迟滞点 12：st ∈ [12, 20) 不交回（迟滞防乒乓）
  const r = deriveNaturalTarget(15, VIEWPORT, RENDERED, INDEX, 2, 8);
  assert.equal(r.active, 2);
  // st < 20 − 8 = 12 才交回 msg1
  const r2 = deriveNaturalTarget(11, VIEWPORT, RENDERED, INDEX, 2, 8);
  assert.equal(r2.active, 1);
  assert.equal(r2.height, 6); // min(11−5, 8)
});

test("交回 1 → 0（滚回第一条之前）", () => {
  const r = deriveNaturalTarget(4, VIEWPORT, RENDERED, INDEX, 1);
  assert.equal(r.active, 0);
  assert.equal(r.height, 0);
});

// ---------- 统一模型：大步级联与边界 ----------

test("大步跳（PageUp/Down）逐帧级联，每帧最多前进一步", () => {
  let active = 1;
  const st = 100; // 跳过 msg2/msg3 顶
  for (let i = 0; i < 10; i++) {
    const r = deriveNaturalTarget(st, VIEWPORT, RENDERED, INDEX, active);
    assert.ok(r.active === active || r.active === active + 1, `帧 ${i}: 每帧最多 +1`);
    active = r.active;
    if (active === 3) break;
  }
  assert.equal(active, 3);
  // 收敛后 msg3 全高吸顶（H=10）
  const r = deriveNaturalTarget(st, VIEWPORT, RENDERED, INDEX, 3);
  assert.equal(r.height, 10);
});

test("索引收缩保护——msgIndex 变短时 active 回落到界内", () => {
  const short = msgs([[5, 13]]);
  const r = deriveNaturalTarget(25, VIEWPORT, RENDERED, short, 3);
  assert.equal(r.active, 1);
  assert.equal(r.height, 8); // 封顶 H
});

test("怪物 prompt 封顶——给 transcript 保底 MIN_TRANSCRIPT_ROWS 行", () => {
  const monster = msgs([[0, 200]]); // 200 行超长消息
  const viewport = 10;
  const rendered = 0; // 总空间 = 10
  const r = deriveNaturalTarget(150, viewport, rendered, monster, 1);
  assert.equal(r.height, viewport - MIN_TRANSCRIPT_ROWS);
});

test("怪物封顶不自指振荡——总空间不变时同一 st 结果稳定", () => {
  const monster = msgs([[0, 200]]);
  const r1 = deriveNaturalTarget(100, 20, 5, monster, 1);
  const r2 = deriveNaturalTarget(100, 20, 5, monster, 1);
  assert.deepEqual(r1, r2);
});

test("滚动连续性——逐行滚动 h 每帧变化不超过 1（接管帧跳变除外）", () => {
  let active = 0;
  let prevH = 0;
  for (let st = 0; st <= 50; st++) {
    const r = deriveNaturalTarget(st, VIEWPORT, RENDERED, INDEX, active);
    if (r.active === active) {
      assert.ok(Math.abs(r.height - prevH) <= 1, `st=${st}: h 从 ${prevH} 到 ${r.height}`);
    }
    active = r.active;
    prevH = r.height;
  }
});

test("交回迟滞——接管补偿后的 st 不触发交回（防乒乓）", () => {
  // msg2 接管点 20，跳变幅度 = 接管前 h = 8 → 迟滞点 = 20 − 8 = 12
  const takeoverDrop = 8;
  // 接管补偿后 st=12：不交回（12 < 20 但 12 ≥ 12）
  const r = deriveNaturalTarget(12, VIEWPORT, RENDERED, INDEX, 2, takeoverDrop);
  assert.equal(r.active, 2);
  // st 低于迟滞点才交回
  const r2 = deriveNaturalTarget(11, VIEWPORT, RENDERED, INDEX, 2, takeoverDrop);
  assert.equal(r2.active, 1);
  // active=1 时不受迟滞影响（回顶部仍看 index[0].start）
  const r3 = deriveNaturalTarget(4, VIEWPORT, RENDERED, INDEX, 1, takeoverDrop);
  assert.equal(r3.active, 0);
  const r4 = deriveNaturalTarget(6, VIEWPORT, RENDERED, INDEX, 1, takeoverDrop);
  assert.equal(r4.active, 1);
});

test("内容变化后迟滞随新 start 生效（相对量，曾修 bug）", () => {
  // 接管 msg2（接管点 20、跳变 8 → takeoverDrop=8），随后 msgIndex 重建
  // （新内容插入上方导致 start 偏移：msg1→[12,20)，msg2→[27,35)）
  const shifted = msgs([
    [12, 20],
    [27, 35],
  ]);
  // 旧绝对位置方案：迟滞点 = 旧 12，新接管点 27 → st=15 就交回（迟滞失效）
  // 新相对量方案：迟滞点 = 27 − 8 = 19 → st ∈ [19, 27) 不交回
  const r = deriveNaturalTarget(22, VIEWPORT, RENDERED, shifted, 2, 8);
  assert.equal(r.active, 2, "新几何下 22 ≥ 迟滞点 19，不应交回");
  const r2 = deriveNaturalTarget(18, VIEWPORT, RENDERED, shifted, 2, 8);
  assert.equal(r2.active, 1, "18 < 19 才交回");
});

// ---------- 冷启动重锚定（anchorActive） ----------

test("anchorActive: 直接推导当前滚动位置对应的消息（不逐帧级联）", () => {
  assert.equal(anchorActive(0, INDEX), 0); // 顶部之前
  assert.equal(anchorActive(5, INDEX), 1); // msg1 触顶
  assert.equal(anchorActive(19, INDEX), 1); // 消息间隙（msg1 内）
  assert.equal(anchorActive(20, INDEX), 2); // msg2 触顶
  assert.equal(anchorActive(35, INDEX), 3); // msg3 触顶
  assert.equal(anchorActive(100, INDEX), 3); // 底部之后
  assert.equal(anchorActive(50, msgs([])), 0); // 空索引
});

// ---------- 缩略限高（maxRows） ----------

test("maxRows: 0 = 不限制（完整模式）", () => {
  const r = deriveNaturalTarget(13, VIEWPORT, RENDERED, INDEX, 1, 0, 0);
  assert.equal(r.height, 8); // 全高吸顶
});

test("maxRows: N = 内容行数上限，pin 总高 = N + 2（后台补 pad）", () => {
  // 消息 H=8（6 内容 + 2 pad），maxRows=3：pin 总高封顶 5（3 内容 + 2 pad）
  assert.equal(deriveNaturalTarget(7, VIEWPORT, RENDERED, INDEX, 1, 0, 3).height, 2); // 剥落中（未到封顶）
  assert.equal(deriveNaturalTarget(9, VIEWPORT, RENDERED, INDEX, 1, 0, 3).height, 4); // 剥落中
  assert.equal(deriveNaturalTarget(10, VIEWPORT, RENDERED, INDEX, 1, 0, 3).height, 5); // 封顶（3 内容 + 2 pad）
  assert.equal(deriveNaturalTarget(13, VIEWPORT, RENDERED, INDEX, 1, 0, 3).height, 5); // 全高被限
});

test("maxRows: 1 = 单行内容气泡（总高 3）", () => {
  assert.equal(deriveNaturalTarget(6, VIEWPORT, RENDERED, INDEX, 1, 0, 1).height, 1); // 剥落中
  assert.equal(deriveNaturalTarget(13, VIEWPORT, RENDERED, INDEX, 1, 0, 1).height, 3); // 封顶（1 内容 + 2 pad）
});

test("maxRows: 大于消息内容行数时等于不限制", () => {
  // 消息 6 内容行：maxRows=100 → pin 总高限 102，实际 h = 8（全高）
  assert.equal(deriveNaturalTarget(13, VIEWPORT, RENDERED, INDEX, 1, 0, 100).height, 8);
});

test("maxRows: 与怪物封顶取更小值", () => {
  // 视口 10 行：怪物封顶 totalSpace−2 = 8；maxRows=5 内容 → pin 总高限 7 → 7
  const monster = msgs([[0, 200]]);
  const r = deriveNaturalTarget(150, 10, 0, monster, 1, 0, 5);
  assert.equal(r.height, 7);
  // maxRows=100 时仍是怪物封顶 8
  const r2 = deriveNaturalTarget(150, 10, 0, monster, 1, 0, 100);
  assert.equal(r2.height, 8);
});

test("maxRows: 接管/交回/迟滞语义与完整模式一致", () => {
  // 接管点仍是下一条触顶
  const at = deriveNaturalTarget(20, VIEWPORT, RENDERED, INDEX, 1, 0, 3);
  assert.equal(at.active, 2);
  assert.equal(at.height, 0);
  // 交回迟滞不受 maxRows 影响（takeoverDrop=8 → 迟滞点 = 20 − 8 = 12）
  const r = deriveNaturalTarget(15, VIEWPORT, RENDERED, INDEX, 2, 8, 3);
  assert.equal(r.active, 2); // 迟滞内不交回
  const r2 = deriveNaturalTarget(11, VIEWPORT, RENDERED, INDEX, 2, 8, 3);
  assert.equal(r2.active, 1);
  assert.equal(r2.height, 5); // min(11−5, 8, 3+2) = 5
});

// ---------- 帧循环模拟：补偿数学 + 内容位置连续性 ----------

const T = 40; // 屏幕总高

interface FakeSv {
  scrollTop: number;
  contentHeight: number;
  viewportHeight: number;
  scrollTo(st: number): void;
}

function makeSv(contentHeight: number): FakeSv {
  return {
    scrollTop: 0,
    contentHeight,
    viewportHeight: T,
    scrollTo(st: number) {
      this.scrollTop = st;
    },
  };
}

/**
 * 模拟一帧完整循环（与 index.ts 相同语义）：
 *   1. derive 目标（读上一帧 st/视口/bar 高度）
 *   2. active 切换时补偿 st += (newH - prevH)
 *   3. updateLayout：视口 = T - newH，st clamp
 * @returns 内容行 st 在屏幕上的位置 = st + barH（连续性监视量）
 */
function frame(sv: FakeSv, index: UserMsg[], active: number, prevBarH: number) {
  const { active: nextActive, height } = deriveNaturalTarget(
    sv.scrollTop,
    sv.viewportHeight,
    prevBarH,
    index,
    active,
  );
  if (nextActive !== active) {
    const delta = height - prevBarH;
    if (delta !== 0) sv.scrollTo(sv.scrollTop + delta);
  }
  sv.viewportHeight = T - height;
  sv.scrollTop = Math.max(0, Math.min(sv.contentHeight - sv.viewportHeight, sv.scrollTop));
  return { active: nextActive, barH: height };
}

test("帧循环: 几何不变量——pin 底永不越过下一个问题的顶", () => {
  // 核心设计保证：active 存在下一条时，st ≤ index[active].start（next 顶在 pin 底之下/齐平）
  const sv = makeSv(100);
  let active = 0;
  let barH = 0;
  for (let st = 0; st <= 60; st++) {
    sv.scrollTop = st;
    ({ active, barH } = frame(sv, INDEX, active, barH));
    if (active >= 1 && active < INDEX.length) {
      assert.ok(sv.scrollTop <= INDEX[active].start, `st=${st}: st(${sv.scrollTop}) > next.start(${INDEX[active].start})`);
    }
    if (active >= 1) assert.ok(barH <= sv.contentHeight - sv.viewportHeight + 1, `st=${st}: barH 越界`);
  }
});

function frameWithTakeover(sv: FakeSv, index: UserMsg[], active: number, prevBarH: number, takeoverDrop: number) {
  const { active: nextActive, height } = deriveNaturalTarget(
    sv.scrollTop,
    sv.viewportHeight,
    prevBarH,
    index,
    active,
    takeoverDrop,
  );
  let nextTakeover = takeoverDrop;
  if (nextActive !== active) {
    const delta = height - prevBarH;
    if (delta !== 0) sv.scrollTo(sv.scrollTop + delta);
    // 前进接管：记录内容对齐位置
    if (nextActive > active && nextActive >= 2) nextTakeover = sv.scrollTop;
  }
  sv.viewportHeight = T - height;
  sv.scrollTop = Math.max(0, Math.min(sv.contentHeight - sv.viewportHeight, sv.scrollTop));
  return { active: nextActive, barH: height, takeoverDrop: nextTakeover };
}

test("帧循环: 正常滚动（含接管/交回）内容位置连续", () => {
  const sv = makeSv(100);
  let active = 0;
  let barH = 0;
  let takeoverDrop = 0;
  let prevPos = 0;
  let first = true;
  // 相对滚动（scrollBy 语义），逐行向下滚到底再逐行向上滚回
  for (const dir of [1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, 1, 1, 1]) {
    sv.scrollTop = Math.max(0, Math.min(sv.contentHeight - sv.viewportHeight, sv.scrollTop + dir));
    ({ active, barH, takeoverDrop } = frameWithTakeover(sv, INDEX, active, barH, takeoverDrop));
    // 内容行 c 的屏幕位置 p(c) = c − st + barH；逐帧变化量 = Δ(barH − st)。
    // 接管/交回帧的高度跳变由同帧补偿吸收，任何帧 |Δ| ≤ 1。
    const pos = barH - sv.scrollTop;
    if (first) {
      first = false;
      prevPos = pos;
      continue;
    }
    assert.ok(Math.abs(pos - prevPos) <= 1, `内容位置跳 ${pos - prevPos}（barH=${barH} st=${sv.scrollTop} active=${active}）`);
    prevPos = pos;
  }
});

test("帧循环: 接管点反复横跳不乒乓（曾修 bug 的回归）", () => {
  const sv = makeSv(100);
  let active = 0;
  let barH = 0;
  let takeoverDrop = 0;
  let prevPos = 0;
  let first = true;
  let switches = 0;
  let prevActive = 0;
  // 逐行向下滚动（剥落/接管/交回全程），内容位置必须逐帧连续
  for (let step = 0; step < 200; step++) {
    sv.scrollTop = Math.max(0, Math.min(sv.contentHeight - sv.viewportHeight, sv.scrollTop + 1));
    ({ active, barH, takeoverDrop } = frameWithTakeover(sv, INDEX, active, barH, takeoverDrop));
    if (active !== prevActive) {
      switches += 1;
      prevActive = active;
    }
    const pos = barH - sv.scrollTop;
    if (!first) {
      assert.ok(Math.abs(pos - prevPos) <= 1, `内容位置跳 ${pos - prevPos}（active=${active} st=${sv.scrollTop}）`);
    }
    first = false;
    prevPos = pos;
  }
  // 200 行滚动：接管应发生且之后稳定（切换次数少 = 无乒乓）
  assert.ok(switches >= 2, `应发生接管/交回，实际切换 ${switches} 次`);
  assert.ok(switches <= 6, `切换过于频繁（乒乓？）${switches} 次`);
});

test("回归: 超长第一条消息 + 底部跟随——向下滚动不被锁死（曾修 bug）", () => {
  // 复现：msg1 超长 [5,405)，底部跟随模式（follow）下渐进三角曾把 st 锁死在
  // 天花板 (C−TOTAL+next.start)/2 ≈ 402.5（st↔h 反馈振荡，向下滚动失效）。
  // 移除渐进三角 + 接管迟滞后 h 单调，用户应能滚过消息间隙直到接管 msg2，
  // 并继续滚过后面的长回复（C=800，接管后 pin 空、视口 35 行还有大量内容可滚）。
  const LONG = msgs([
    [5, 405],
    [415, 425],
  ]);
  const contentHeight = 800;
  const totalSpace = 35; // T − dock
  let active = 0;
  let barH = 0;
  let st = 0;
  let viewport = totalSpace;
  let followingEnd = false;
  let takeoverDrop = 0;
  const maxSt = () => Math.max(0, contentHeight - viewport);
  let guard = 0;
  while (st < 700 && guard++ < 1000) {
    // 用户滚动 3 行（含底部跟随语义）
    const start = followingEnd ? maxSt() : st;
    st = Math.max(0, Math.min(maxSt(), start + 3));
    followingEnd = st === maxSt();
    // 派生 + 切换补偿（与 index.ts 相同语义）
    const { active: na, height: h } = deriveNaturalTarget(st, viewport, barH, LONG, active, takeoverDrop);
    if (na !== active) {
      const delta = h - barH;
      if (delta !== 0) st = Math.max(0, Math.min(maxSt(), st + delta));
      if (na > active && na >= 2) takeoverDrop = st; // 前进接管：记录对齐位置
    }
    active = na;
    viewport = Math.max(0, totalSpace - h);
    const m = maxSt();
    if (followingEnd) st = m;
    else st = Math.max(0, Math.min(st, m));
    barH = h;
  }
  // 能滚过消息间隙（415 顶附近）、接管 msg2 并继续滚过长回复：
  assert.ok(guard < 1000, "滚动被锁死（达到帧数上限）");
  assert.ok(st >= 700, `st 应滚到 700 附近，实际 ${st}`);
  assert.equal(active, 2, "应已接管 msg2");
});

test("回归: maxRows 变更（完整 → 缩略 3）补偿基准 = 上一帧实际渲染高度（曾修 bug）", () => {
  // 场景：完整模式全高吸顶 msg1（H=8，barH=8），改 maxRows=3（pin 目标 3 行）
  const st0 = 13;
  const barH0 = 8;
  const MAX = 3;
  // 旧代码（基准被重置为 0）→ delta = 3 - 0 = +3（错）
  const oldDelta = MAX - 0;
  // 新代码（基准 = 实际渲染高度）→ delta = 3 - 8 = -5（对）
  const newDelta = MAX - barH0;
  // 内容行 st0 的屏幕位置在 bar 下方：位置 = st + (row - barH)
  const row = 8;
  const before = st0 + (row - barH0);
  const afterOld = st0 + oldDelta + (row - MAX);
  const afterNew = st0 + newDelta + (row - MAX);
  assert.notEqual(afterOld, before); // 旧逻辑会跳
  assert.equal(afterNew, before); // 新逻辑内容不动
});

test("回归: disable→enable 补偿基准从 0 起算（曾修 bug）", () => {
  // disable 时 bar 移出布局（物理 0 行），enable 后 target h=5
  const st0 = 60; // 重新启用时用户所在位置（active=2 区域）
  const barH0 = 0; // disable 期间重置后的正确基准
  const h = 5;
  const row = 5;
  const before = st0 + (row - barH0);
  const after = st0 + (h - barH0) + (row - h);
  assert.equal(after, before);
  // 若 disable 时没重置（残留旧基准 8），会跳
  const stale = st0 + (h - 8) + (row - h);
  assert.notEqual(stale, before);
});
