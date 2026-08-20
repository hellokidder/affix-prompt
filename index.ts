/**
 * affix-prompt.ts — transcript 中「用户输入消息」的 Affix 吸顶（仅支持 fullscreen TUI 模式）
 *
 * 适用：pi 0.84+ 的 fullscreen TUI 模式（--tui-mode fullscreen 或 /settings 里切换）。
 *
 * v1.0.0 行为（统一模型：剥落 + maxRows 限高）：
 *   - 每条 user 消息一视同仁：触顶 → 剥落（固定副本显示该消息真实渲染行的前 h 行，
 *     h = clamp(scrollTop - start, 0, H)，H = 消息真实渲染高度）→ 完全吸顶
 *     （与渲染组件同高同内容）→ 被下一条接管。首条消息只是「无前驱」的特例。
 *   - maxRows 缩略（内容行数语义）：maxRows > 0 时 pin 显示消息前 maxRows 行内容，
 *     上下 pad 在后台补（pin 总高 = maxRows + 2）；maxRows = 0（默认）为完整模式。
 *   - 接管/交回：下一条触顶即接管、滚回上一条即交回（带迟滞防乒乓）；
 *     切换帧 pin 高度离散跳变，由同帧 scrollTo 补偿吸收（内容位置连续）。
 *   - 大跳级联/内容变化时防御性 scrollTo 补偿（布局 translateBox 同帧校正）。
 *   - 吸顶条内容 = 消息组件的实时渲染（live UserMessageComponent，同宽同主题），
 *     不同高度的消息天然按各自真实高度吸顶。
 *
 * 实现原理：
 *   1. 布局：在 fullscreenLayoutRoot（pi 持久化的 VStack）里于 transcriptScrollView
 *      上方插入吸顶条（AffixPromptBar）。basis auto → 高度 = 渲染行数（动态 0..h）。
 *      其余结构不动（dock 保持 pi 原生原样；检测到旧版插件残留自动还原）。
 *   2. 感知滚动：hook transcriptScrollView.updateLayout（布局每帧调用），
 *      内容变化时重建消息区间表；吸顶条 render 内直接读当前 scrollTop 派生目标
 *      （同帧对齐，无 1 帧滞后）。
 *   3. 消息位置：rebuildIndex 测量 documentContainer 子组件渲染行数，给每条
 *      UserMessageComponent 计算 [start, end) 并保存组件引用（吸顶条按当前
 *      主题/宽度实时渲染该组件，保证同高同内容）。
 *   4. 状态机：active（当前吸顶消息，0=none）+ 前进接管/后退交回（见头注释），
 *      切换高度跳变时 render 内 scrollTo 补偿（同帧校正）。
 *
 * 注意：依赖 pi 内部结构（layoutRoot / ScrollView.updateLayout / 组件树），
 * 均带结构校验，识别失败会安全跳过（不影响正常使用）。
 * 扩展是进程内加载的，改文件后需 /reload 或重启 pi 才生效。
 *
 * 用法：
 *   /affix-prompt            切换 开/关
 *   /affix-prompt on|off     开启/关闭
 *   /affix-prompt maxrows N  设置缩略行数（pin 显示 N 行内容，总高 N+2；N=0 完整）
 *   /affix-prompt 5          同上（裸数字快捷方式）
 * 状态保存在 ~/.pi/agent/affix-prompt.json（{ enabled, maxRows }），跨会话记忆。
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { UserMessageComponent, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text, VStack } from "@earendil-works/pi-tui";

import { anchorActive, deriveNaturalTarget, type UserMsg } from "./state-machine.ts";

const STATE_FILE = join(homedir(), ".pi", "agent", "affix-prompt.json");
const CAPTURE_WIDGET_KEY = "__affix_prompt_capture";
const BAR_MARK = "__affixPromptBar";
const CHECK_INTERVAL_MS = 400; // 内容/宽度/主题变化检测
const REBUILD_DELAY_MS = 120; // 重建区间表的节流（越短越不容易用到旧表）
/** UserMessageComponent 末行追加的 shell 集成 zone 后缀（133;B/133;C），吸顶条需剥掉。
 *  模块级常量：正则字面量每次求值都会新建 RegExp 对象，热路径上避免每帧分配。 */
const ZONE_SUFFIX_RE = /(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+$/;

/** 运行时结构（pi 内部 layoutRoot / Stack.entries 的形状） */
interface StackEntryLike {
  component: any;
  basis?: number | string;
  grow?: number;
  shrink?: number;
  minSize?: number;
}
interface AltScreenLike {
  mode?: string;
  layoutRoot?: { entries: StackEntryLike[] } | null;
  requestRender?(force?: boolean): void;
}

/** patch 在 ScrollView 上的动态属性（收敛 as any 的类型逃逸） */
interface PatchedScrollView {
  contentHeight: number;
  updateLayout: (contentHeight: number, viewportHeight: number, requestRender: () => void) => void;
  __affixPatched?: boolean;
  __affixOrigUpdateLayout?: (contentHeight: number, viewportHeight: number, requestRender: () => void) => void;
}

/** 吸顶条目标（render 时即时派生） */
interface BarTarget {
  mode: "active" | "none";
  height: number;
  comp: UserMessageComponent | undefined; // live 组件（吸顶条按当前主题/宽度实时渲染）
}

const NONE_TARGET: BarTarget = { mode: "none", height: 0, comp: undefined };
/** 空态共享行数组（布局 paintBox 只读行数组——replace/composite 均产生新字符串，
 *  已核对 pi 的 layout.js——共享安全，避免每帧新建空数组） */
const EMPTY_LINES: string[] = [];

/** 持久化状态（~/.pi/agent/affix-prompt.json） */
interface AffixState {
  enabled: boolean;
  /** 缩略内容行数上限：0 = 不限制（完整模式）；>0 = pin 显示前 N 行内容
   *  （pin 总高 = N + 2：上下 pad 在后台补，用户无感知） */
  maxRows: number;
}

function loadState(): AffixState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<AffixState> & { mode?: string };
    // 旧格式兼容（v0.0.x 的 mode 字段）：oneline → maxRows=1，natural → 0
    const legacyOneline = parsed.mode === "oneline";
    // v0.1.0 的 maxRows 语义是「pin 总行数（含 pad）」，新语义是「内容行数」——
    // 迁移 = 旧值 − 2（旧 3 行气泡 → 1 行内容；旧 5 → 3 内容 + 2 pad = 同视觉）
    const legacyMaxRows = typeof parsed.maxRows === "number" ? parsed.maxRows : 0;
    return {
      // 手改配置写 "off"/0 等非布尔值时按关闭处理，而不是误当成开启
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      maxRows:
        legacyOneline
          ? 1
          : legacyMaxRows > 0
            ? Math.max(1, Math.floor(legacyMaxRows) - 2)
            : 0,
    };
  } catch {
    return { enabled: true, maxRows: 0 };
  }
}

function saveState(state: AffixState): void {
  try {
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    // 先写临时文件再 rename：避免中途崩溃留下截断的 JSON（loadState 有兜底，但原子写更稳）
    const tmp = STATE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
  } catch {
    /* 写失败不阻塞 */
  }
}

/**
 * 吸顶条组件。内容在 render 时即时派生（computeTarget 读当前 scrollTop + 状态机）。
 * 统一模型：显示「当前 user 消息」实时渲染行的前 h 行（0..min(H, maxRows) 动态高度）。
 * 空态返回 0 行（不占位）。
 * 性能：render 输出缓存——静止时（宽度/高度/缩略行数/组件/主题均不变）直接复用
 * 上次行数组，完全跳过消息组件的全量渲染（O(行数)）；滚动中 h 每帧变则正常渲染。
 */
class AffixPromptBar {
  lastWidth = 0;
  /** 上一帧实际渲染高度（离散切换补偿 Δ 的基准） */
  renderedHeight = 0;

  // —— render 输出缓存（键：宽度 + 目标高度 + 缩略行数 + 组件引用 + 主题指纹）——
  private cacheCw = 0;
  private cacheHeight = -1;
  private cacheMaxRows = -1;
  private cacheComp: UserMessageComponent | undefined;
  private cacheFp = "";
  private cacheLines: string[] | undefined;
  // —— 组件全量行缓存（与 h 无关：滚动时只需重新 slice，省掉 O(行数) 的拼接）——
  private allCw = 0;
  private allComp: UserMessageComponent | undefined;
  private allFp = "";
  private allLines: string[] | undefined;

  constructor(
    private readonly getUi: () => ExtensionUIContext | undefined,
    private readonly getMaxRows: () => number,
    private readonly getContentWidth: (width: number) => number,
    private readonly computeTarget: () => BarTarget,
  ) {}

  /** 主题指纹：缓存键组成部分（主题切换后 pin 行缓存失效）。
   *  用 getFgAnsi/getBgAnsi（Map 查找、零分配）而非 fg/bg（内部做字符串拼接）——
   *  本方法在 render 热路径上每帧至少调用一次。 */
  private fingerprint(): string {
    const ui = this.getUi();
    if (!ui) return "";
    try {
      const t = ui.theme;
      return [
        t.getFgAnsi("userMessageText"),
        t.getBgAnsi("userMessageBg"),
        t.getFgAnsi("mdHeading"),
        t.getFgAnsi("mdLink"),
        t.getFgAnsi("mdCode"),
        t.getFgAnsi("mdQuote"),
      ].join("|");
    } catch {
      return "";
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const target = this.computeTarget();
    let lines: string[] | undefined;
    if (target.mode === "active" && target.comp && target.height > 0) {
      const cw = this.getContentWidth(width);
      const maxRows = this.getMaxRows();
      const fp = this.fingerprint(); // 每帧至多一次（快速路径与渲染路径共用）
      // 快速路径：渲染输入与上次完全一致（宽度/高度/缩略行数/组件引用）→
      // 主题指纹验证后直接复用上次行数组——静止时零渲染零分配
      if (
        this.cacheLines &&
        this.cacheCw === cw &&
        this.cacheHeight === target.height &&
        this.cacheMaxRows === maxRows &&
        this.cacheComp === target.comp &&
        this.cacheFp === fp
      ) {
        lines = this.cacheLines;
      }
      if (!lines) {
        // 实时渲染该消息组件（同宽同主题）。UserMessageComponent 的渲染结构是
        // [padTop, 内容行..., padBottom]（outputPad=1）。分三种情况：
        //   1. 完全吸顶（h = H）：组件原样（同高同内容，含首尾 pad）；
        //   2. 自然模式部分剥落（maxRows = 0）：连续文本切片 [padTop, 内容 0..h−2]
        //      ——pin 是消息滚出屏幕部分的延续，不插入 pad 行（避免「扫线/覆盖层」）；
        //   3. 缩略模式（maxRows > 0）：对称完整气泡 [padTop, 内容前 (h−2) 行, padBottom]
        //      ——上下边框对称（用户选择保留；代价是内容区少 1 行，已知取舍）。
        let all: string[];
        // 组件全量行缓存（与 h 无关）：滚动时同组件同宽度直接复用，只做 slice
        if (this.allComp === target.comp && this.allCw === cw && this.allFp === fp && this.allLines) {
          all = this.allLines;
        } else {
          try {
            all = target.comp.render(cw);
          } catch {
            all = [];
          }
          this.allComp = target.comp;
          this.allCw = cw;
          this.allFp = fp;
          this.allLines = all;
        }
        let lastIsFinal = false; // 末行是否为组件最终行（唯一可能带 zone 后缀的行）
        try {
          const h = Math.min(target.height, all.length);
          if (h >= all.length) {
            lines = all.slice(); // 完全吸顶：与消息组件同高同内容（含首尾 pad）
            lastIsFinal = true;
          } else if (maxRows === 0) {
            lines = all.slice(0, h); // 自然模式：连续文本切片
          } else if (h <= 1) {
            lines = all.slice(0, h); // 缩略模式剥落初期（只有消息顶部 pad 滚出）
          } else {
            lines = [all[0], ...all.slice(1, h - 1), all[all.length - 1]]; // 对称气泡
            lastIsFinal = true;
          }
        } catch {
          lines = [];
        }
        // UserMessageComponent 渲染会给首行加 133;A、末行加 133;B/133;C zone 标记
        // （布局绘制只剥前缀）。吸顶条是消息副本，末行的 zone 后缀会原样写进终端
        // （污染 shell 集成标记）→ 剥掉。只有末行 = 组件最终行时才可能带后缀：
        // 自然模式剥落是中间切片（滚动热路径每帧重建），直接跳过正则匹配。
        if (lastIsFinal && lines.length > 0) {
          lines[lines.length - 1] = lines[lines.length - 1].replace(ZONE_SUFFIX_RE, "");
        }
        this.cacheCw = cw;
        this.cacheHeight = target.height;
        this.cacheMaxRows = maxRows;
        this.cacheComp = target.comp;
        this.cacheFp = fp;
        this.cacheLines = lines;
      }
    } else {
      // 空态：复用共享空数组，清缓存（下次激活时重新渲染）
      this.cacheLines = undefined;
      lines = EMPTY_LINES;
    }
    this.renderedHeight = lines.length;
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;
  let capturedTui: AltScreenLike | undefined;
  const state = loadState();
  let enabled = state.enabled;
  let timer: ReturnType<typeof setInterval> | undefined;

  let msgIndex: UserMsg<UserMessageComponent>[] = []; // user 消息区间表 [start, end) × 组件引用
  let active = 0; // 当前吸顶消息：0=none，k = msgIndex[k-1]
  let lastActive = -1; // 切换检测（-1 = 未初始化）
  let takeoverDrop = 0; // 最近一次前进接管的 pin 跳变幅度（= 接管前 pin 高，相对量）
  let maxRows = state.maxRows; // 缩略最大行数：0 = 不限制，>0 = 封顶 N 行
  let lastContentHeight: number | undefined;
  let lastWidth = 0;
  let lastMeasuredTotal = 0; // 最近一次测量的内容总行数（与 layout contentHeight 对比自检）
  let lastSelfCheckHeight: number | undefined; // 自检收敛 guard：同一 contentHeight 只触发一次自检重建
  let structureWarned = false; // 结构异常只向用户报一次
  /** chat 容器引用缓存（rebuild 时用 includes 校验，省去每次 instanceof 扫描） */
  let chatContainer: any;

  const bar = new AffixPromptBar(
    () => ui,
    () => maxRows,
    (w) => {
      const sv = getTranscript();
      return sv && typeof sv.getContentWidth === "function" ? sv.getContentWidth(w) : w;
    },
    () => {
      const sv = getTranscript();
      return sv ? computeTarget(sv) : NONE_TARGET;
    },
  );
  (bar as any)[BAR_MARK] = true; // 布局里识别吸顶条的标记（/reload 后也能认出来）

  // 调试：AFFIX_PROMPT_DEBUG=1 时把日志写入 /tmp/affix-prompt-debug.log
  const DEBUG = process.env.AFFIX_PROMPT_DEBUG === "1";
  const DEBUG_FILE = "/tmp/affix-prompt-debug.log";
  const dlog = (...args: unknown[]): void => {
    if (!DEBUG) return;
    const line = `[${new Date().toISOString().slice(11, 23)}] ${args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")}`;
    try {
      appendFileSync(DEBUG_FILE, line + "\n");
    } catch {
      /* 日志写失败不影响功能 */
    }
  };

  const getTui = (): AltScreenLike | undefined => capturedTui;

  /** 从布局根里找 transcript ScrollView（primary: true 的组件） */
  let cachedTranscript: any;
  const getTranscript = (): any => {
    const root = capturedTui?.layoutRoot;
    if (!root || !Array.isArray(root.entries)) return undefined;
    // 引用缓存 + includes 校验（与 chatContainer 同理）：render 热路径上每帧会调两次
    // （computeTarget + getContentWidth），缓存命中时把两次 find 扫描降为两次引用比较。
    if (cachedTranscript && root.entries.includes(cachedTranscript)) return cachedTranscript;
    cachedTranscript = root.entries.find((e) => e?.component?.primary === true)?.component;
    return cachedTranscript;
  };

  /** 捕获 tui 引用（widget factory 同步执行一次；捕获后立刻移除，不留痕迹） */
  function captureTui(uiCtx: ExtensionUIContext): void {
    if (capturedTui) return;
    uiCtx.setWidget(CAPTURE_WIDGET_KEY, (tui) => {
      capturedTui = tui as unknown as AltScreenLike;
      return new Text("", 0, 0);
    });
    uiCtx.setWidget(CAPTURE_WIDGET_KEY, undefined);
  }

  /**
   * 旧插件残留自愈：仅当精确识别出 [editor(minSize=3), 5 元 rest] 模式时还原 dock 顺序
   * （[pending, status, widgetAbove, EDITOR, widgetBelow, footer]）。
   * 其他未知结构一律返回 undefined（调用方平铺保序），绝不嵌套重组他人 entry。
   */
  function wrapResidue(others: StackEntryLike[]): StackEntryLike | undefined {
    if (others.length !== 2) return undefined;
    const editor = others.find((e) => e.minSize === 3);
    const rest = others.find((e) => e !== editor && Array.isArray(e.component?.entries));
    if (!editor || !rest) return undefined;
    const r = rest.component.entries as StackEntryLike[];
    if (r.length < 5) return undefined; // 不是 dock 形态（pending/status/widgetAbove/widgetBelow/footer）
    const restored = [...r.slice(0, 3), editor, ...r.slice(3)];
    return { component: new VStack(restored as any), basis: "auto", grow: 0, shrink: 1, minSize: 1 };
  }

  /** 结构校验失败信号：dlog + 一次性 notify（fullscreen 下才可能触发，regular 模式正常跳过不报） */
  function warnStructure(reason: string): void {
    dlog(`ensureBarInLayout: ${reason}`);
    if (!structureWarned && ui) {
      structureWarned = true;
      ui.notify(`affix-prompt: 检测到 pi 布局结构变化（${reason}），吸顶已暂停。请检查扩展兼容性。`, "warning");
    }
  }

  /** 布局自愈 + 挂吸顶条：目标结构 [吸顶条?] [transcript] [dock]，其余一律不动 */
  function ensureBarInLayout(): void {
    const tui = getTui();
    if (!tui || tui.mode !== "fullscreen") return; // regular 模式没有布局系统，正常跳过
    const root = tui.layoutRoot;
    if (!root || !Array.isArray(root.entries) || root.entries.length < 2) {
      warnStructure("layoutRoot 不可用");
      return;
    }

    const entries = root.entries;
    const transcriptEntry = entries.find((e) => e?.component?.primary === true);
    if (!transcriptEntry) {
      warnStructure("找不到 primary transcript");
      return;
    }

    const barIdx = entries.findIndex((e) => (e.component as any)?.[BAR_MARK]);
    const others = entries.filter(
      (e) => e !== transcriptEntry && (e.component as any)?.[BAR_MARK] !== true,
    );

    const done =
      (enabled && barIdx === 0 && entries[0].component === bar && entries[1] === transcriptEntry && others.length === 1) ||
      (!enabled && barIdx === -1 && entries[0] === transcriptEntry && others.length === 1);
    if (done) return;

    // /reload 后是新 bar 对象：从旧吸顶条（BAR_MARK 标记）继承「上一帧实际渲染高度」，
    // 让补偿基准（delta = target − renderedHeight）跨 reload 连续，避免内容跳动
    const oldBar = barIdx >= 0 ? (entries[barIdx].component as any) : undefined;
    if (oldBar && oldBar !== bar && typeof oldBar.renderedHeight === "number") {
      bar.renderedHeight = oldBar.renderedHeight;
    }

    const newEntries: StackEntryLike[] = [];
    if (enabled) {
      newEntries.push({ component: bar, basis: "auto", grow: 0, shrink: 0, minSize: 0 });
    }
    newEntries.push(transcriptEntry);
    if (others.length === 1) {
      newEntries.push(others[0]); // 原样复用 dock，绝不动内部
    } else if (others.length > 1) {
      const restored = wrapResidue(others);
      if (restored) {
        newEntries.push(restored); // 旧插件残留 → 精确还原
      } else {
        // 未知结构（其他扩展或未来 pi 的 root entry）：平铺保序，
        // 保持各 entry 原始选项，绝不嵌套重组（嵌套会让对方按 root.entries 找不到自己）
        newEntries.push(...others);
        dlog(
          "ensureBarInLayout: 未知 root 结构，平铺保序",
          others.map((o) => (o.component as any)?.constructor?.name ?? "?").join(","),
        );
      }
    }
    entries.splice(0, entries.length, ...newEntries);
    tui.requestRender?.();

    const sv = getTranscript() as PatchedScrollView | undefined;
    if (enabled && sv && !sv.__affixPatched) patchTranscript(sv);
    else if (!enabled && sv) unpatchTranscript(sv);
  }

  /** hook ScrollView.updateLayout：布局每帧调用 → 内容变化即时感知（滚动由 render 派生） */
  function patchTranscript(sv: PatchedScrollView): void {
    const orig = sv.updateLayout.bind(sv);
    sv.__affixOrigUpdateLayout = orig;
    sv.__affixPatched = true;
    sv.updateLayout = (contentHeight: number, viewportHeight: number, requestRender: () => void) => {
      orig(contentHeight, viewportHeight, requestRender);
      const ch = sv.contentHeight;
      if (ch !== lastContentHeight) {
        lastContentHeight = ch;
        scheduleRebuild(); // 内容变化 → 重建区间表（节流）
      }
    };
  }

  function unpatchTranscript(sv: PatchedScrollView | undefined): void {
    if (!sv || !sv.__affixPatched) return;
    sv.updateLayout = sv.__affixOrigUpdateLayout ?? sv.updateLayout;
    delete sv.__affixPatched;
    delete sv.__affixOrigUpdateLayout;
    lastContentHeight = undefined;
  }

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRebuild(): void {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      rebuildIndex();
    }, REBUILD_DELAY_MS);
  }

  /** 子组件渲染行数。
   *  不在此处做跨 rebuild 的持久缓存：assistant 流式输出、工具执行结果到达、展开/折叠
   *  都会让组件高度变化，持久缓存（旧版 WeakMap）会返回陈旧高度——后续 user 消息的
   *  start offset 被低估，pin 提前剥落，与 transcript 内的 padTop 重复一行
   *  （视觉上「吸顶条上方多了一行」）。Box/Markdown 自带按宽度的渲染缓存，稳定组件
   *  命中 O(1)，故直接测量即可，无需自建缓存。 */
  function measureLines(c: any, width: number): number {
    try {
      return c.render?.(width)?.length ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * 重建 user 消息区间表：测量 documentContainer 子组件渲染行数。
   * documentContainer.children = [header, loadedResources, chat]（chat 按内容识别，不依赖下标）。
   * 每条 UserMessageComponent 记录 [start, end) 并保存组件引用（供吸顶条实时渲染）。
   * 每次 rebuild 都重新测量所有子组件高度（不跨 rebuild 缓存）：Box/Markdown 自带按宽度的
   * 渲染缓存，稳定组件 O(1) 命中；而 assistant/工具等高度会变化的组件必须重新测量，否则
   * 陈旧高度会使后续 user 消息的 start 偏移、pin 与 transcript 重复一行。
   */
  function rebuildIndex(): void {
    const sv = getTranscript();
    if (!sv || !enabled) return;
    // 用 scroll view 的实际内容宽度测量（scrollbar=always 时内容会少 1 列）
    const width =
      typeof (sv as any).getContentWidth === "function"
        ? (sv as any).getContentWidth(bar.lastWidth)
        : bar.lastWidth;
    if (!width) return;
    const doc = (sv as any).child;
    if (!doc || !Array.isArray(doc.children) || doc.children.length < 3) return;
    const wasEmpty = msgIndex.length === 0; // 冷启动标记（reload/enable/maxRows 变更后）

    // chat 容器按内容识别（含 UserMessageComponent 的那个），不依赖固定下标；
    // 缓存引用 + includes 校验（O(children) 引用比较），避免每次 rebuild 都做
    // instanceof 扫描（会话长、消息多时该扫描是 rebuild 的主要成本）
    if (!chatContainer || !doc.children.includes(chatContainer)) {
      chatContainer = doc.children.find(
        (c: any) =>
          Array.isArray(c?.children) && c.children.some((ch: any) => ch instanceof UserMessageComponent),
      );
    }
    if (!chatContainer) {
      dlog("rebuild: 找不到 chat 容器，清空区间表");
      msgIndex = [];
      return;
    }
    const chatIdx = doc.children.indexOf(chatContainer);

    let offset = 0;
    for (let i = 0; i < chatIdx; i++) offset += measureLines(doc.children[i], width);

    const newIndex: UserMsg<UserMessageComponent>[] = [];
    if (Array.isArray(chatContainer.children)) {
      for (const child of chatContainer.children) {
        const h = measureLines(child, width);
        if (child instanceof UserMessageComponent) {
          newIndex.push({ start: offset, end: offset + h, comp: child });
        }
        offset += h;
      }
    }
    msgIndex = newIndex;
    lastMeasuredTotal = offset;
    // 冷启动（reload / enable / maxRows 变更后首次重建）：把 active 一次性重锚定到
    // 当前滚动位置——避免逐帧级联（pin 在多条消息间「窜」）以及 takeoverDrop=0
    // 时接管补偿弹回交回区的乒乓。lastActive 同步：首帧不触发切换补偿。
    if (wasEmpty && newIndex.length > 0) {
      const st = typeof sv.scrollTop === "number" ? sv.scrollTop : 0;
      active = anchorActive(st, newIndex);
      lastActive = active;
      takeoverDrop = 0;
    }
    dlog(
      `rebuild width=${width} total=${offset} contentHeight=${sv.contentHeight} msgs=${newIndex.length} active=${active}`,
      newIndex.map((m) => `[${m.start},${m.end}]`).join(" "),
    );
  }

  /**
   * 统一模型目标（render 内即时派生）。目标派生在纯函数 deriveNaturalTarget
   * （state-machine.ts，可单测）：状态机 + 剥落 + 缩略限高 + 怪物封顶。
   * 本函数只负责把结果应用到组件状态 + 防御性补偿副作用。
   * 缩略（maxRows > 0）与完整（maxRows = 0）共用同一模型：只是高度是否封顶。
   */
  function computeTarget(sv: any): BarTarget {
    const st = typeof sv.scrollTop === "number" ? sv.scrollTop : 0;
    const viewportHeight = sv.viewportHeight ?? 0;

    const { active: nextActive, height } = deriveNaturalTarget(
      st,
      viewportHeight,
      bar.renderedHeight,
      msgIndex,
      active,
      takeoverDrop,
      maxRows,
    );
    const switched = nextActive !== lastActive; // 与上一帧比较（补偿触发条件）
    active = nextActive;

    let target: BarTarget = NONE_TARGET;
    if (nextActive >= 1 && nextActive <= msgIndex.length && height > 0) {
      target = { mode: "active", height, comp: msgIndex[nextActive - 1].comp };
    }

    // —— 防御性补偿（正常路径 h 连续无跳变；大跳级联/内容变化时兜底）——
    if (switched) {
      const delta = target.height - bar.renderedHeight;
      if (delta !== 0 && typeof sv.scrollTo === "function") {
        sv.scrollTo(st + delta);
      }
      // 前进接管：记录 pin 跳变幅度（= 接管前 pin 高，实际渲染值）供交回迟滞。
      // 用相对量而非绝对位置：msgIndex 重建后消息 start 会偏移，
      // 绝对位置迟滞立即失效 → 交回无迟滞 → 弹回接管点 → 乒乓（抽搐/滚动失效）
      if (nextActive > lastActive && nextActive >= 2) {
        takeoverDrop = bar.renderedHeight;
      }
      dlog(
        `active ${lastActive} -> ${nextActive} h=${target.height} Δ=${delta}${delta !== 0 ? " compensated" : ""} scrollTop=${st}->${sv.scrollTop} viewport=${viewportHeight} maxRows=${maxRows} takeoverDrop=${takeoverDrop}`,
      );
      lastActive = nextActive;
    }
    return target;
  }

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    captureTui(ctx.ui);
    ensureBarInLayout();
    if (!timer) {
      timer = setInterval(() => {
        // 运行期 tui-mode 切换（regular→fullscreen）自愈：补挂吸顶条 + 补 patch。
        // done 检查只是几次数组查找，400ms 一次可忽略。
        if (!enabled) return;
        ensureBarInLayout();
        // 内容/宽度变化 → 重建；重建后请求一帧（让状态机按新索引收敛）。
        // 主题只影响颜色序列、不影响渲染行数，无需检测。
        const sv = getTranscript();
        if (sv) {
          const ch = sv.contentHeight;
          // 自检收敛 guard：lastSelfCheckHeight 记录上次自检触发时的 contentHeight，
          // 同一值只自检重建一次——避免测量值与 contentHeight 存在持久偏差时
          // 变成永不停歇的 400ms 全量重建 + requestRender 循环（内容变化后 ch 变，自然解锁）
          if (
            ch !== lastContentHeight ||
            bar.lastWidth !== lastWidth ||
            (ch !== lastMeasuredTotal && ch !== lastSelfCheckHeight)
          ) {
            lastContentHeight = ch;
            lastWidth = bar.lastWidth;
            if (ch !== lastMeasuredTotal) lastSelfCheckHeight = ch;
            rebuildIndex();
            capturedTui?.requestRender?.();
          }
        }
      }, CHECK_INTERVAL_MS);
      timer.unref?.();
    }
  });

  pi.on("session_shutdown", async () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
      rebuildTimer = undefined;
    }
    unpatchTranscript(getTranscript());
    ui?.setWidget(CAPTURE_WIDGET_KEY, undefined);
    ui = undefined;
    capturedTui = undefined;
    cachedTranscript = undefined;
    msgIndex = [];
    active = 0;
    lastActive = -1;
    takeoverDrop = 0;
    lastMeasuredTotal = 0;
    lastSelfCheckHeight = undefined;
    structureWarned = false;
    chatContainer = undefined;
  });

  pi.registerCommand("affix-prompt", {
    description:
      "切换「用户输入消息 Affix 吸顶」（fullscreen 模式）。用法: /affix-prompt [on|off|maxrows N|N]",
    handler: async (args, ctx) => {
      ui = ctx.ui;
      captureTui(ctx.ui);
      // 普通模式（终端主屏 + 回滚区）没有 layoutRoot/滚动视口，吸顶条结构上无法工作；
      // 状态仍会保存，切回 fullscreen 后自动生效。capturedTui 是 live proxy，mode 实时。
      const fsHint = capturedTui?.mode !== "fullscreen" ? "（仅 fullscreen 模式生效）" : "";
      const arg = args.trim().toLowerCase();

      // 应用 maxRows 并重置状态机（高度规则变了；补偿基准 bar.renderedHeight 保留，
      // 首帧补偿以真实渲染高度为基准，内容不跳）
      const applyMaxRows = (next: number, label: string): void => {
        maxRows = next;
        saveState({ enabled, maxRows });
        msgIndex = [];
        active = 0;
        lastActive = -1;
        takeoverDrop = 0;
        ensureBarInLayout();
        rebuildIndex();
        capturedTui?.requestRender?.();
        ctx.ui.notify(`affix-prompt: ${label}${fsHint}`, "info");
      };

      // 参数形式：/affix-prompt maxrows N | max N | N（N = 内容行数，pin 总高 = N + 2；
      // N = 0 = 完整模式不限制）
      const numMatch = arg.match(/^(?:maxrows?|max)\s+(\d+)$/) ?? arg.match(/^(\d+)$/);
      if (numMatch) {
        const n = parseInt(numMatch[1], 10);
        if (Number.isFinite(n) && n >= 0) {
          applyMaxRows(
            n,
            n > 0 ? `已设置缩略行数 ${n}（pin 显示 ${n} 行内容）` : "已切换为完整模式（不限制行数）",
          );
          return;
        }
      }
      // 开关
      if (arg !== "" && arg !== "on" && arg !== "off") {
        ctx.ui.notify(
          `affix-prompt: 未知参数 "${arg}"。用法: /affix-prompt [on|off|maxrows N|N]${fsHint}`,
          "warning",
        );
        return;
      }
      const next = arg === "on" ? true : arg === "off" ? false : !enabled;
      enabled = next;
      saveState({ enabled, maxRows });
      if (!enabled) {
        msgIndex = [];
        active = 0;
        lastActive = -1;
        takeoverDrop = 0;
        lastMeasuredTotal = 0;
        bar.renderedHeight = 0; // 吸顶条已移出布局：重置物理基准，重新启用时补偿从 0 起算
      }
      ensureBarInLayout();
      if (enabled) {
        rebuildIndex();
        capturedTui?.requestRender?.();
      }
      ctx.ui.notify(
        (enabled
          ? `affix-prompt: Affix 吸顶已开启（${maxRows > 0 ? `缩略 ${maxRows} 行内容` : "完整"}模式）`
          : "affix-prompt: 已关闭") + fsHint,
        "info",
      );
    },
  });
}
