/**
 * affix-prompt.ts — transcript 中「用户输入消息」的 Affix 吸顶（类似 antd Affix）
 *
 * 适用：pi 0.84+ 的 fullscreen TUI 模式（--tui-mode fullscreen 或 /settings 里切换）。
 *
 * v0.0.3 行为（所有 user 消息统一的「剥落 + 接管」模型）：
 *   - 每条 user 消息一视同仁：触顶 → 剥落（固定副本显示该消息真实渲染行的前 h 行，
 *     h = clamp(scrollTop - start, 0, H)，H = 消息真实渲染高度）→ 完全吸顶
 *     （与渲染组件同高同内容）→ 被下一条消息接管。首条消息只是「无前驱」的特例。
 *   - 前进接管：下一条消息顶滚入 pin 高度（scrollTop ≥ start_{i+1} + H_i）时，
 *     pin 切换为下一条消息，高度连续（h 恰好 = H_i）；仅当下一条更矮时才需补偿。
 *   - 后退交回：当前消息顶回落视口顶以下（scrollTop < start_i，剥落完全坍缩）时，
 *     pin 换回上一条全高。前进/后退边界不同 → 状态式迟滞，补偿回越不触发乒乓。
 *   - 同帧补偿：切换时高度变化 Δ 在 render 内 scrollTo(st + Δ)，pi 布局的
 *     translateBox 在 updateLayout 之后执行 → 内容同一帧校正，零跳动。
 *   - 吸顶条内容 = 消息组件的实时渲染（live UserMessageComponent，同宽同主题），
 *     不同高度的消息天然按各自真实高度吸顶。
 *
 * 实现原理：
 *   1. 布局：在 fullscreenLayoutRoot（pi 持久化的 VStack）里于 transcriptScrollView
 *      上方插入吸顶条（AffixPromptBar）。basis auto → 高度 = 渲染行数（动态 0..H）。
 *      其余结构不动（dock 保持 pi 原生原样；检测到旧版插件残留自动还原）。
 *   2. 感知滚动：hook transcriptScrollView.updateLayout（布局每帧调用），
 *      内容变化时重建消息区间表；吸顶条 render 内直接读当前 scrollTop 派生目标
 *      （同帧对齐，无 1 帧滞后）。
 *   3. 消息位置：rebuildIndex 测量 documentContainer 子组件渲染行数，给每条
 *      UserMessageComponent 计算 [start, end) 并保存组件引用（吸顶条按当前
 *      主题/宽度实时渲染该组件，保证同高同内容）。
 *   4. 状态机：active（当前吸顶消息，0=none）+ 前进/后退边界（见头注释），
 *      切换高度变化时 render 内 scrollTo 补偿。
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
import { Text, VStack } from "@earendil-works/pi-tui";

const STATE_FILE = join(homedir(), ".pi", "agent", "affix-prompt.json");
const CAPTURE_WIDGET_KEY = "__affix_prompt_capture";
const BAR_MARK = "__affixPromptBar";
const CHECK_INTERVAL_MS = 400; // 内容/宽度/主题变化检测
const REBUILD_DELAY_MS = 120; // 重建区间表的节流（越短越不容易用到旧表）
const MIN_TRANSCRIPT_ROWS = 2; // 怪物 prompt 封顶时给 transcript 保底行数

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
  /** 真实 UserMessageComponent 引用：吸顶条按当前主题/宽度实时渲染（同高同内容） */
  comp: UserMessageComponent;
}

/** 吸顶条目标（render 时即时派生） */
interface BarTarget {
  mode: "active" | "none";
  height: number;
  comp: UserMessageComponent | undefined;
}

const NONE_TARGET: BarTarget = { mode: "none", height: 0, comp: undefined };

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
 * 吸顶条组件。内容在 render 时即时派生（computeTarget 读当前 scrollTop + 状态机），
 * 显示「当前 user 消息」实时渲染行的前 h 行（0..H 动态高度，完全吸顶时与原文同高）。
 * 空态返回 0 行（不占位）。
 */
class AffixPromptBar {
  lastWidth = 0;
  /** 上一帧实际渲染高度（离散切换补偿 Δ 的基准） */
  renderedHeight = 0;

  constructor(
    private readonly getContentWidth: (width: number) => number,
    private readonly computeTarget: () => BarTarget,
  ) {}

  render(width: number): string[] {
    this.lastWidth = width;
    const target = this.computeTarget();
    let lines: string[] = [];
    if (target.mode === "active" && target.comp && target.height > 0) {
      const cw = this.getContentWidth(width);
      try {
        // 实时渲染该消息组件（同宽同主题），取前 h 行；OSC133 标记由布局绘制时剥除
        const all = target.comp.render(cw);
        lines = all.slice(0, Math.min(target.height, all.length));
      } catch {
        lines = [];
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

  let index: UserMsg[] = []; // user 消息区间表 [start, end) × 组件引用
  let active = 0; // 当前吸顶消息：0=none，k = index[k-1]
  let lastActive = -1; // 切换检测（-1 = 未初始化）
  let lastContentHeight: number | undefined;
  let lastWidth = 0;
  let lastMeasuredTotal = 0; // 最近一次测量的内容总行数（与 layout contentHeight 对比自检）
  let lastThemeFp = ""; // 主题指纹（吸顶条按主题渲染，变化 → 重建）

  const bar = new AffixPromptBar(
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

  // 调试：POKEPOKE_AFFIX_DEBUG=1 时把日志写入 /tmp/affix-prompt-debug.log
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

  /** hook ScrollView.updateLayout：布局每帧调用 → 内容变化即时感知（滚动由 render 派生） */
  function patchTranscript(sv: any): void {
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
   * 每条 UserMessageComponent 记录 [start, end) 并保存组件引用（供吸顶条实时渲染）。
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
    if (chat && Array.isArray(chat.children)) {
      for (const child of chat.children) {
        let h = 0;
        if (child?.render) {
          try {
            h = child.render(width).length;
          } catch {
            h = 0;
          }
        }
        if (child instanceof UserMessageComponent) {
          const raw = typeof (child as any).text === "string" ? (child as any).text : "";
          newIndex.push({ start: offset, end: offset + h, text: raw.split("\n")[0] ?? "", comp: child });
        }
        offset += h;
      }
    }
    index = newIndex;
    lastMeasuredTotal = offset;
    dlog(
      `rebuild width=${width} total=${offset} contentHeight=${sv.contentHeight} msgs=${newIndex.length} active=${active}`,
      newIndex.map((m) => `[${m.start},${m.end}]`).join(" "),
    );
  }

  /**
   * 目标状态（render 内即时派生 + 状态机）。每次渲染读当前 scrollTop：
   *   - 前进接管：active = k 且 scrollTop ≥ start_{k+1} + H_k（下一条顶吸满 pin 高度）
   *   - 后退交回：active = k 且 scrollTop < start_k（当前消息顶回落视口顶以下）
   *   - 高度：h = clamp(scrollTop - start_active, 0, H_active)，怪物 prompt 封顶
   *   - active 变化且高度变化 → 同帧 scrollTo(st + Δ) 补偿（布局 translateBox 校正）
   */
  function computeTarget(sv: any): BarTarget {
    const st = typeof sv.scrollTop === "number" ? sv.scrollTop : 0;
    const viewportHeight = sv.viewportHeight ?? 0;

    // —— 状态机（状态式迟滞：前进/后退边界不同，补偿回越不乒乓）——
    if (index.length === 0) {
      active = 0;
    } else if (active === 0) {
      if (st >= index[0].start) active = 1;
    } else {
      if (active > index.length) active = index.length; // 索引收缩保护
      const msg = index[active - 1];
      if (msg) {
        if (st < msg.start) {
          active -= 1; // 后退交回（1 → 0 = none）
        } else if (active < index.length) {
          const next = index[active]; // 下一条（0-based = active）
          const H = msg.end - msg.start;
          if (st >= next.start + H) active += 1; // 前进接管
        }
      } else {
        active = 0;
      }
    }

    // —— 高度：h = clamp(st - start_active, 0, H_active)，封顶保底 ——
    let target: BarTarget = NONE_TARGET;
    if (active >= 1 && active <= index.length) {
      const msg = index[active - 1];
      const H = msg.end - msg.start;
      let h = Math.max(0, Math.min(st - msg.start, H));
      // 怪物 prompt 保护：给 transcript 至少保留 MIN_TRANSCRIPT_ROWS 行
      // （用「总空间 - 保底」，与当前 h 无关 → 稳定，不会自指振荡）
      const totalSpace = viewportHeight + bar.renderedHeight;
      h = Math.max(0, Math.min(h, totalSpace - MIN_TRANSCRIPT_ROWS));
      if (h > 0) {
        target = { mode: "active", height: Math.floor(h), comp: msg.comp };
      }
    }

    // —— 离散切换补偿（仅 active 变化且高度变化；reveal 连续变化自锚定）——
    if (active !== lastActive) {
      const delta = target.height - bar.renderedHeight;
      if (delta !== 0 && typeof sv.scrollTo === "function") {
        sv.scrollTo(st + delta);
      }
      dlog(
        `active ${lastActive} -> ${active} h=${target.height} Δ=${delta}${delta !== 0 ? " compensated" : ""} scrollTop=${st}->${sv.scrollTop} viewport=${viewportHeight}`,
      );
      lastActive = active;
    }
    return target;
  }

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    captureTui(ctx.ui);
    ensureBarInLayout();
    if (!timer) {
      timer = setInterval(() => {
        // 内容/宽度/主题变化 → 重建；重建后请求一帧（让状态机按新索引收敛）
        const sv = getTranscript();
        if (enabled && sv) {
          const ch = sv.contentHeight;
          const fp = themeFingerprint();
          const themeChanged = fp !== lastThemeFp;
          lastThemeFp = fp;
          if (
            themeChanged ||
            ch !== lastContentHeight ||
            bar.lastWidth !== lastWidth ||
            ch !== lastMeasuredTotal
          ) {
            lastContentHeight = ch;
            lastWidth = bar.lastWidth;
            rebuildIndex();
            capturedTui?.requestRender?.();
          }
        }
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
    active = 0;
    lastActive = -1;
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
        index = [];
        active = 0;
        lastActive = -1;
        lastMeasuredTotal = 0;
      }
      ensureBarInLayout();
      if (enabled) {
        rebuildIndex();
        capturedTui?.requestRender?.();
      }
      ctx.ui.notify(
        enabled ? "affix-prompt: user 输入 Affix 吸顶已开启" : "affix-prompt: 已关闭",
        "info",
      );
    },
  });
}
