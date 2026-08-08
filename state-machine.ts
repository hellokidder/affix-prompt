/**
 * state-machine.ts — affix-prompt 的纯函数状态机（无副作用、不依赖 pi 运行时）。
 *
 * 职责划分：
 *   - 本文件：给定 (滚动状态, 消息区间表, 当前 active) → 派生下一帧 (active, pin 高度)。
 *     纯函数，便于确定性单测（tests/derive-target.test.ts）。
 *   - index.ts：读 sv.scrollTop/viewportHeight、维护 lastActive/takeoverDrop、
 *     补偿 scrollTo、dlog 等副作用全部留在调用方。
 *
 * 统一模型（v1.0.0）：
 *   - 触顶即剥落：st ≥ start 后 h = st − start（pin = 消息滚出屏幕部分的副本），
 *     到 H（消息高）全高吸顶；maxRows > 0 时 pin 封顶在 maxRows（缩略）。
 *   - 前进接管：st ≥ start_{k+1}（下一条触顶即接管），接管帧 h 跳变由补偿吸收。
 *   - 后退交回：st 低于接管迟滞点 takeoverDrop 才交回（防接管补偿触发乒乓）。
 *   - 怪物 prompt 封顶：h ≤ totalSpace − MIN_TRANSCRIPT_ROWS（给 transcript 保底，
 *     用「总空间 − 保底」而非当前 h → 稳定不自指）。
 */

/** 消息区间表条目（comp 泛型化，避免依赖 UserMessageComponent 类型） */
export interface UserMsg<T = unknown> {
  start: number;
  end: number;
  comp: T;
}

/** 怪物 prompt 封顶时给 transcript 保底的行数 */
export const MIN_TRANSCRIPT_ROWS = 2;

interface NaturalDerive {
  active: number;
  height: number;
}

/**
 * 冷启动重锚定（纯函数）：给定当前 scrollTop，直接推导 active（= 最后一条
 * start ≤ st 的消息，0 = none）。用于 reload / enable / maxRows 变更后的首次
 * 索引重建——此时状态机从零开始，若逐帧级联收敛（每帧最多前进 1 步），
 * pin 会在多条消息间「窜」；且 takeoverDrop=0（无交回迟滞）时接管补偿
 * 可能弹回交回区触发乒乓。一次性锚定到位可同时避免两者。
 */
export function anchorActive(st: number, index: readonly UserMsg[]): number {
  let a = 0;
  for (let i = 0; i < index.length; i++) {
    if (st >= index[i].start) a = i + 1;
    else break;
  }
  return a;
}

/**
 * 统一模型目标派生（纯函数）：状态机 + 高度。
 * @param st 当前 scrollTop
 * @param viewportHeight transcript 视口高度（上一帧）
 * @param renderedHeight 吸顶条上一帧实际渲染高度（怪物封顶的「总空间」基准）
 * @param index 消息区间表
 * @param active 当前 active（0 = none，k = index[k-1]）
 * @param takeoverDrop 最近一次前进接管的 pin 高度跳变幅度（= 接管前 pin 高，相对量）。
 *   交回条件带迟滞（st 需低于 msg.start − takeoverDrop），避免「接管补偿 →
 *   落回交回区 → 交回补偿 → 弹回接管点」的乒乓。用相对量而非绝对位置：
 *   msgIndex 重建（流式/宽度变化）后消息 start 会偏移，绝对位置迟滞立即失效；
 *   相对量随新 start 自动生效。
 * @param maxRows 缩略内容行数上限（用户语义）：0 = 不限制（完整模式）；
 *   N > 0 = pin 显示前 N 行内容（上下 pad 另算，pin 总高 = N + 2）。
 */
export function deriveNaturalTarget(
  st: number,
  viewportHeight: number,
  renderedHeight: number,
  index: readonly UserMsg[],
  active: number,
  takeoverDrop = 0,
  maxRows = 0,
): NaturalDerive {
  let nextActive = active;
  if (index.length === 0) {
    nextActive = 0;
  } else if (nextActive === 0) {
    if (st >= index[0].start) nextActive = 1;
  } else {
    if (nextActive > index.length) nextActive = index.length; // 索引收缩保护
    const msg = index[nextActive - 1];
    if (msg) {
      // 后退交回：触顶回落视口顶以下。active ≥ 2 时带迟滞：
      // 需滚过接管点 − 跳变（takeoverDrop）才交回，避免接管帧补偿后的
      // st（恰在 [接管点−跳变, 接管点)）立刻触发交回 → 乒乓。
      if (st < msg.start && (nextActive === 1 || st < msg.start - takeoverDrop)) {
        nextActive -= 1; // 后退交回（1 → 0 = none）
      } else if (nextActive < index.length) {
        const next = index[nextActive]; // 下一条（0-based = active）
        if (st >= next.start) nextActive += 1; // 前进接管（触顶即接管）
      }
    } else {
      nextActive = 0;
    }
  }

  let height = 0;
  if (nextActive >= 1 && nextActive <= index.length) {
    const msg = index[nextActive - 1];
    const H = msg.end - msg.start;
    let h = Math.max(0, Math.min(st - msg.start, H)); // 剥落/吸顶
    // 缩略限高：maxRows 是内容行数上限，pin 总行数 = 内容 + 上下 pad = maxRows + 2
    // （用户配置的 maxRows 语义 = 能看到几行内容；后台完成 +2）
    if (maxRows > 0) h = Math.min(h, maxRows + 2);
    // 怪物 prompt 保护（与当前 h 无关 → 稳定，不会自指振荡）
    const totalSpace = viewportHeight + renderedHeight;
    h = Math.max(0, Math.min(h, totalSpace - MIN_TRANSCRIPT_ROWS));
    height = Math.floor(h);
  }
  return { active: nextActive, height };
}
