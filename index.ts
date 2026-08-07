/**
 * affix-prompt.ts — transcript 中「用户输入消息」的 Affix 吸顶（类似 antd Affix）
 *
 * 适用：pi 0.84+ 的 fullscreen TUI 模式（--tui-mode fullscreen 或 /settings 里切换）。
 *
 * v0.0.2 行为（每个对话第 1 条 user 消息 → 全高「剥落式」吸顶）：
 *   - 固定副本 = transcript 内该消息的「真实渲染行」（同宽同主题），不再是缩略态：
 *     完全吸顶时高度与原文一致（H = 该消息渲染行数），部分吸顶时显示前 h 行。
 *   - 向上滚动（内容上移）：以该消息上沿碰触 TUI 上沿为界（scrollTop = start）。
 *     继续上滚：顶部出现固定副本，高度 h = clamp(scrollTop - start, 0, H)
 *     （露出量 = 滚出上沿的距离，封顶 H ——「高度与渲染组件一致」）。
 *   - 向下滚动：已有固定副本时，以渲染中组件下沿与固定组件下沿为界；
 *     继续下滚，固定高度 1:1 坍缩回 0，回到原文。
 *   - 锚定原理：h 与 scrollTop 同步变化时，原文下方内容冻结在屏幕固定行
 *     （屏幕行 = 内容行 - start），滚动输入被完全吸收进吸顶高度 → 无跳动、无需补偿。
 *   - 后续消息（第 2 条起）：保留 v0.0.1 的缩略吸顶（3 行截断），
 *     仅在首条完全吸顶后、滚动足够深时接管；接管/交回是离散高度变化，
 *     做一次 scrollTop 补偿（scrollTo(st + Δ)），内容不跳动。
 *
 * 实现原理：
 *   1. 布局：在 fullscreenLayoutRoot（pi 持久化的 VStack）里于 transcriptScrollView
 *      上方插入固定吸顶条（AffixPromptBar）。basis auto → 高度 = 渲染行数（动态 0..H）。
 *      其余结构不动（dock 保持 pi 原生原样；检测到旧版插件残留自动还原）。
 *   2. 感知滚动：hook transcriptScrollView.updateLayout（布局每帧调用），
 *      滚动/内容变化时即时读取 scrollTop 并查表。
 *   3. 消息位置：枚举 documentContainer 子组件并测量渲染行数，
 *      给每条 UserMessageComponent 计算 [start, end) 区间；同时缓存第 1 条
 *      消息的真实渲染行（供吸顶条复用，保证同高同内容）。
 *   4. 查表：首条消息 → h = clamp(scrollTop - start, 0, H)；
 *      完全吸顶后按 v0.0.1 规则查后续消息的缩略吸顶（含底部短回答置空）。
 *
 * 注意：依赖 pi 内部结构（layoutRoot / ScrollView.updateLayout / 组件树），
 * 均带结构校验，识别失败会安全跳过（不影响正常使用）。
 * 扩展是进程内加载的，改文件后需 /reload 或重启 pi 才生效。
 *
 * 用法：
 *   /affix-prompt       切换 开/关
 *   /affix-prompt on    开启
 *   /affix-prompt off   关闭
 * 状态保存在 ~/.pi/agent/affix-prompt.json，跨会话记忆。
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { UserMessageComponent, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, VStack } from "@earendil-works/pi-tui";

const STATE_FILE = join(homedir(), ".pi", "agent", "affix-prompt.json");
const CAPTURE_WIDGET_KEY = "__affix_prompt_capture";
const BAR_MARK = "__affixPromptBar";
const CHECK_INTERVAL_MS = 400; // 内容/宽度/主题变化检测
const REBUILD_DELAY_MS = 120; // 重建区间表的节流（越短越不容易用到旧表）
const PIN_HEIGHT = 3; // 后续消息缩略吸顶高度（v0.0.1 遗留：pad+内容+pad）
const MIN_TRANSCRIPT_ROWS = 2; // reveal 封顶时给 transcript 保底行数（怪物 prompt 保护）
// OSC133 区域标记：pi 布局绘制时会剥除；这里在缓存前先剥掉，保持吸顶条缓存干净
const OSC133_RE = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

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
interface UserMsg {
  start: number;
  end: number;
  text: string;
}

/** 吸顶条目标状态（渲染时即时派生；用于检测离散变化 & 切换补偿） */
interface BarTarget {
  mode: "reveal" | "pin" | "none";
  height: number;
  text: string;
  lines: string[]; // reveal 内容引用：重建后引用变化 → 强制重绘
}

/** 空 lines 的共享引用（pin/none 用；避免每帧新数组导致状态比对误判） */
const NO_LINES: string[] = [];
/** none 目标的共享引用 */
const NONE_TARGET: BarTarget = { mode: "none", height: 0, text: "", lines: NO_LINES };

function loadEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { enabled?: boolean };
    return parsed.enabled !== false;
  } catch {
    return true;
  }
}

function saveEnabled(enabled: boolean): void {
  try {
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ enabled }, null, 2));
  } catch {
    /* 写失败不阻塞 */
  }
}

/**
 * 吸顶条组件。内容在 render 时即时派生（computeTarget 直接读当前 scrollTop），
 * 消除「布局先量吸顶条、后跑 updateLayout」造成的 1 帧滞后 → 剥落/坍缩无抽搐。
 *   - reveal（首条 user 消息）：复用 transcript 内该消息的真实渲染行，前 h 行；
 *   - pin（后续消息，v0.0.1 遗留）：截断单行的 3 行气泡。
 * 空态返回 0 行（不占位）。
 */
class AffixPromptBar {
  private pinCached: string[] | undefined;
  private pinCachedWidth: number | undefined;
  private pinCachedText: string | undefined;
  private pinCachedFp: string | undefined;
  lastWidth = 0;
  /** 上一帧实际渲染高度（pin 迟滞边界 & 封顶用；初始 3 = v0.0.1 边界） */
  renderedHeight = PIN_HEIGHT;

  constructor(
    private readonly getUi: () => ExtensionUIContext | undefined,
    private readonly getContentWidth: (width: number) => number,
    private readonly computeTarget: () => BarTarget,
  ) {}

  /** 主题指纹：pin 渲染缓存比对用；主题切换后返回不同字符串 → 触发重建 */
  private fingerprint(): string {
    const ui = this.getUi();
    if (!ui) return "";
    try {
      const t = ui.theme;
      return [
        t.fg("userMessageText", "x"),
        t.bg("userMessageBg", "x"),
        t.fg("mdHeading", "x"),
        t.fg("mdLink", "x"),
        t.fg("mdCode", "x"),
        t.fg("mdQuote", "x"),
      ].join("|");
    } catch {
      return "";
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const target = this.computeTarget();
    let lines: string[] = [];
    if (target.mode === "reveal" && target.lines.length > 0) {
      // reveal：transcript 内真实渲染行的前 h 行（同宽同内容，高度 = 行数）
      const rows = Math.min(target.height, target.lines.length);
      if (rows > 0) lines = target.lines.slice(0, rows);
    } else if (target.mode === "pin" && target.text.length > 0 && width > 1) {
      // pin：按 transcript 内容宽度渲染（与 reveal / 原文气泡对齐），恒 3 行
      const cw = this.getContentWidth(width);
      const fp = this.fingerprint();
      if (
        !this.pinCached ||
        this.pinCachedWidth !== cw ||
        this.pinCachedText !== target.text ||
        this.pinCachedFp !== fp
      ) {
        this.pinCachedWidth = cw;
        this.pinCachedText = target.text;
        this.pinCachedFp = fp;
        try {
          const singleLine = truncateToWidth(target.text, Math.max(4, cw - 4));
          lines = new UserMessageComponent(singleLine).render(cw);
          if (lines.length === 0) lines = ["", "", ""];
        } catch {
          lines = ["", "", ""];
        }
        this.pinCached = lines;
      } else {
        lines = this.pinCached;
      }
    }
    this.renderedHeight = lines.length;
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;
  let capturedTui: AltScreenLike | undefined;
  let enabled = loadEnabled();
  let timer: ReturnType<typeof setInterval> | undefined;

  const bar = new AffixPromptBar(
    () => ui,
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

  let index: UserMsg[] = []; // user 消息区间表 [start, end) × 文本
  let firstLines: string[] = []; // 首条 user 消息的真实渲染行（reveal 复用，同高同内容）
  let lastBarState: BarTarget = { ...NONE_TARGET };
  let lastContentHeight: number | undefined;
  let lastWidth = 0;
  let lastMeasuredTotal = 0; // 最近一次测量的内容总行数（与 layout contentHeight 对比自检）
  let lastThemeFp = ""; // 主题指纹（reveal 缓存行依赖主题，变化 → 重建）

  // 调试：POKEPOKE_AFFIX_DEBUG=1 时把日志写入 /tmp/affix-prompt-debug.log
  // （fullscreen TUI 里 console.log 会和绘制混在一起，写文件最可靠）
  const DEBUG = process.env.POKEPOKE_AFFIX_DEBUG === "1";
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
  const getTranscript = (): any => {
    const root = capturedTui?.layoutRoot;
    if (!root || !Array.isArray(root.entries)) return undefined;
    return root.entries.find((e) => e?.component?.primary === true)?.component;
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
   * 把旧插件拆散的片段还原成 pi 原生 dock 顺序：
   * 若 others 是 [editor, rest]，把 editor 插回 rest 的第 4 位，
   * 恢复 [pending, status, widgetAbove, EDITOR, widgetBelow, footer]。
   */
  function wrapResidue(others: StackEntryLike[]): StackEntryLike {
    const editor = others.find((e) => e.minSize === 3);
    const rest = others.find((e) => e !== editor && Array.isArray(e.component?.entries));
    if (editor && rest) {
      const r = rest.component.entries as StackEntryLike[];
      const restored = [...r.slice(0, 3), editor, ...r.slice(3)];
      return { component: new VStack(restored as any), basis: "auto", grow: 0, shrink: 1, minSize: 1 };
    }
    return { component: new VStack(others as any), basis: "auto", grow: 0, shrink: 1, minSize: 1 };
  }

  /** 布局自愈 + 挂吸顶条：目标结构 [吸顶条?] [transcript] [dock]，其余一律不动 */
  function ensureBarInLayout(): void {
    const tui = getTui();
    if (!tui || tui.mode !== "fullscreen") return;
    const root = tui.layoutRoot;
    if (!root || !Array.isArray(root.entries) || root.entries.length < 2) return;

    const entries = root.entries;
    const transcriptEntry = entries.find((e) => e?.component?.primary === true);
    if (!transcriptEntry) return;

    const barIdx = entries.findIndex((e) => (e.component as any)?.[BAR_MARK]);
    const others = entries.filter(
      (e) => e !== transcriptEntry && (e.component as any)?.[BAR_MARK] !== true,
    );

    const done =
      (enabled && barIdx === 0 && entries[0].component === bar && entries[1] === transcriptEntry && others.length === 1) ||
      (!enabled && barIdx === -1 && entries[0] === transcriptEntry && others.length === 1);
    if (done) return;

    const newEntries: StackEntryLike[] = [];
    if (enabled) {
      newEntries.push({ component: bar, basis: "auto", grow: 0, shrink: 0, minSize: 0 });
    }
    newEntries.push(transcriptEntry);
    if (others.length === 1) {
      newEntries.push(others[0]); // 原样复用 dock，绝不动内部
    } else if (others.length > 1) {
      newEntries.push(wrapResidue(others)); // 旧插件残留 → 还原
    }
    entries.splice(0, entries.length, ...newEntries);
    tui.requestRender?.();

    const sv = getTranscript();
    if (enabled && sv && !sv.__affixPatched) patchTranscript(sv);
    else if (!enabled && sv) unpatchTranscript(sv);
  }

  /** hook ScrollView.updateLayout：布局每帧调用 → 滚动/内容变化即时感知 */
  function patchTranscript(sv: any): void {
    const orig = sv.updateLayout.bind(sv);
    sv.__affixOrigUpdateLayout = orig;
    sv.__affixPatched = true;
    sv.updateLayout = (contentHeight: number, viewportHeight: number, requestRender: () => void) => {
      orig(contentHeight, viewportHeight, requestRender);
      refreshAffix(); // 滚动查表，即时
      const ch = sv.contentHeight;
      if (ch !== lastContentHeight) {
        lastContentHeight = ch;
        scheduleRebuild(); // 内容变化 → 重建区间表（节流）
      }
    };
  }

  function unpatchTranscript(sv: any): void {
    if (!sv || !sv.__affixPatched) return;
    sv.updateLayout = sv.__affixOrigUpdateLayout;
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

  /**
   * 重建 user 消息区间表：测量 documentContainer 全部子组件渲染行数。
   * documentContainer.children = [header, loadedResources, chat]。
   * 同时缓存第 1 条 user 消息的真实渲染行（剥掉 OSC133），供吸顶条复用。
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

    let offset = 0;
    for (const c of doc.children.slice(0, 2)) {
      if (!c?.render) continue;
      try {
        offset += c.render(width).length;
      } catch {
        /* 测量失败跳过该组件 */
      }
    }

    const chat = doc.children[2];
    const newIndex: UserMsg[] = [];
    const newFirstLines: string[] = [];
    if (chat && Array.isArray(chat.children)) {
      for (const child of chat.children) {
        let lines: string[] = [];
        if (child?.render) {
          try {
            lines = child.render(width);
          } catch {
            lines = [];
          }
        }
        if (child instanceof UserMessageComponent) {
          const raw = typeof (child as any).text === "string" ? (child as any).text : "";
          // 第一条 user 消息：缓存其真实渲染行（剥掉 OSC133 区域标记）
          if (newIndex.length === 0) {
            for (const l of lines) newFirstLines.push(l.replace(OSC133_RE, ""));
          }
          newIndex.push({ start: offset, end: offset + lines.length, text: raw.split("\n")[0] ?? "" });
        }
        offset += lines.length;
      }
    }
    index = newIndex;
    firstLines = newFirstLines;
    lastMeasuredTotal = offset;
    dlog(
      `rebuild width=${width} total=${offset} contentHeight=${sv.contentHeight} msgs=${newIndex.length} firstH=${newFirstLines.length}`,
      newIndex.map((m) => `[${m.start},${m.end}]`).join(" "),
    );
  }

  /**
   * 目标状态（渲染时即时派生 + refreshAffix 共用同一函数）。
   *   - 首条 user 消息：reveal，h = clamp(scrollTop - start, 0, H)；
   *     完全吸顶（h = H）后，若后续消息上沿滚入吸顶条槽位（v0.0.1 规则，
   *     边界用上一帧实际渲染高度 → 迟滞，避免补偿回越导致乒乓）则切换为 pin
   *     （含底部短回答置空规则）。
   *   - reveal 高度直接由当前 scrollTop 派生：布局同帧内 bar 高与滚动位置严格
   *     同步 → 接缝内容与原文逐行对齐，滚动过程零滞后、无抽搐。
   */
  function computeTarget(sv: any): BarTarget {
    const st = typeof sv.scrollTop === "number" ? sv.scrollTop : 0;
    const contentHeight = sv.contentHeight ?? 0;
    const viewportHeight = sv.viewportHeight ?? 0;
    const maxSt = Math.max(0, contentHeight - viewportHeight);

    const first = index[0];
    if (!first || firstLines.length === 0) return NONE_TARGET;

    const H = first.end - first.start;
    const d = st - first.start;
    let target: BarTarget = NONE_TARGET;

    if (d >= H) {
      // 首条完全吸顶：查后续消息的缩略吸顶（v0.0.1 规则 + 底部短回答置空）
      const last = index[index.length - 1];
      const bottomClear = st >= maxSt - 1 && !!last && last.start <= st && last.end > st;
      let pin: UserMsg | undefined;
      if (!bottomClear) {
        // 迟滞边界：用上一帧实际渲染高度（pin=3 / reveal=h），
        // 接管/交回位置由当前模式决定 → 补偿回越不会再次触发切换
        const barH = bar.renderedHeight;
        for (let i = index.length - 1; i >= 1; i--) {
          if (index[i].start + barH <= st) {
            pin = index[i];
            break;
          }
        }
      }
      if (pin) {
        target = { mode: "pin", height: PIN_HEIGHT, text: pin.text, lines: NO_LINES };
      } else {
        target = { mode: "reveal", height: H, text: "", lines: firstLines };
      }
    } else if (d > 0) {
      target = { mode: "reveal", height: d, text: "", lines: firstLines };
    }

    if (target.mode === "reveal") {
      // 怪物 prompt 保护：给 transcript 至少保留 MIN_TRANSCRIPT_ROWS 行。
      // 用「总空间 - 保底」（与当前 h 无关 → 稳定，不会因 viewport 依赖 h 而振荡）
      const totalSpace = viewportHeight + bar.renderedHeight;
      const capped = Math.max(0, Math.min(target.height, totalSpace - MIN_TRANSCRIPT_ROWS));
      if (capped <= 0) return NONE_TARGET;
      target = { ...target, height: Math.floor(capped) };
    }
    return target;
  }

  /**
   * 离散变化检测（每帧 updateLayout hook + 间隔）：
   *   - 渲染已即时派生当前状态；这里只在状态变化时处理：
   *     涉及 pin 的高度变化（reveal↔pin、pin 出现/消失）→ scrollTo(st + Δ) 补偿，
   *     内容不跳动；reveal↔reveal 连续变化自锚定，无需补偿。
   */
  function refreshAffix(): void {
    if (!enabled) return;
    const sv = getTranscript();
    if (!sv) return;
    const target = computeTarget(sv);
    const prev = lastBarState;
    if (
      prev.mode === target.mode &&
      prev.height === target.height &&
      prev.text === target.text &&
      prev.lines === target.lines
    ) {
      return;
    }
    lastBarState = target;
    const delta = target.height - prev.height;
    if (delta !== 0 && (prev.mode === "pin" || target.mode === "pin")) {
      if (typeof sv.scrollTo === "function") sv.scrollTo(sv.scrollTop + delta);
    }
    capturedTui?.requestRender?.();
    dlog(
      `state=${target.mode} h=${target.height}${target.mode === "pin" ? ` text=${JSON.stringify(target.text)}` : ""} scrollTop=${sv.scrollTop}${delta !== 0 ? ` Δ=${delta}${prev.mode === "pin" || target.mode === "pin" ? " compensated" : ""}` : ""} rendered=${bar.renderedHeight} contentHeight=${sv.contentHeight} viewport=${sv.viewportHeight}`,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    captureTui(ctx.ui);
    ensureBarInLayout();
    if (!timer) {
      timer = setInterval(() => {
        // 内容/宽度/主题变化 → 重建；否则仅查表（滚动由 hook 即时处理）
        const sv = getTranscript();
        if (enabled && sv) {
          const ch = sv.contentHeight;
          const fp = themeFingerprint();
          const themeChanged = fp !== lastThemeFp;
          lastThemeFp = fp;
          // 内容/宽度/主题变化，或测量总额与布局 contentHeight 漂移 → 重建自检
          if (
            themeChanged ||
            ch !== lastContentHeight ||
            bar.lastWidth !== lastWidth ||
            ch !== lastMeasuredTotal
          ) {
            lastContentHeight = ch;
            lastWidth = bar.lastWidth;
            rebuildIndex();
          }
        }
        refreshAffix();
      }, CHECK_INTERVAL_MS);
      timer.unref?.();
    }
  });

  function themeFingerprint(): string {
    if (!ui) return "";
    try {
      const t = ui.theme;
      return [
        t.fg("userMessageText", "x"),
        t.bg("userMessageBg", "x"),
        t.fg("mdHeading", "x"),
        t.fg("mdLink", "x"),
        t.fg("mdCode", "x"),
        t.fg("mdQuote", "x"),
      ].join("|");
    } catch {
      return "";
    }
  }

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
    index = [];
    firstLines = [];
    lastBarState = { ...NONE_TARGET };
    lastMeasuredTotal = 0;
    lastThemeFp = "";
  });

  pi.registerCommand("affix-prompt", {
    description: "切换「用户输入消息 Affix 吸顶」（fullscreen 模式）。用法: /affix-prompt [on|off]",
    handler: async (args, ctx) => {
      ui = ctx.ui;
      captureTui(ctx.ui);
      const arg = args.trim().toLowerCase();
      const next = arg === "on" ? true : arg === "off" ? false : !enabled;
      enabled = next;
      saveEnabled(enabled);
      if (!enabled) {
        bar.renderedHeight = PIN_HEIGHT;
        index = [];
        firstLines = [];
        lastBarState = { ...NONE_TARGET };
        lastMeasuredTotal = 0;
      }
      ensureBarInLayout();
      if (enabled) {
        rebuildIndex();
        refreshAffix();
      }
      ctx.ui.notify(
        enabled ? "affix-prompt: user 输入 Affix 吸顶已开启" : "affix-prompt: 已关闭",
        "info",
      );
    },
  });
}
