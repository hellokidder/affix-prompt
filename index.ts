/**
 * affix-prompt.ts — transcript 中「用户输入消息」的 Affix 吸顶（类似 antd Affix）
 *
 * 适用：pi 0.84+ 的 fullscreen TUI 模式（--tui-mode fullscreen 或 /settings 里切换）。
 *
 * 行为（经典 Affix 语义，逐条 user 消息）：
 *   - user 消息正常作为对话流渲染、正常滚动，不修改任何消息组件
 *   - 切换时机：Q2 的上边框滚入吸顶条槽位（start + BAR_HEIGHT <= scrollTop）时，
 *     即 Q2 上边框与固定住的 Q1 上边框处于同一位置（屏幕顶部那条线）才变更
 *   - 空态不占位（0 行）；底部短回答场景（最后一条消息仍可见）时置空
 *   - 目的：滚动阅读 assistant 回答时，随时知道当前内容对应哪个提问
 *
 * 实现原理：
 *   1. 布局：在 fullscreenLayoutRoot（pi 持久化的 VStack，跨模式切换复用）里
 *      于 transcriptScrollView 上方插入一个固定吸顶条（AffixPromptBar）。
 *      其余结构不动 —— dock（pending/status/widget/EDITOR/widget/footer）
 *      保持 pi 原生原样。若检测到旧版插件残留的异常结构（如 editor 被拆到
 *      顶部），自动还原为规范结构 [吸顶条?] [transcript] [dock]。
 *   2. 感知滚动：hook transcriptScrollView.updateLayout（布局系统每帧调用），
 *      滚动/内容变化时即时读取 scrollTop 并查表。
 *   3. 消息位置：枚举 documentContainer 下所有子组件并测量渲染行数，
 *      给每条 UserMessageComponent 计算 [start, end) 内容区间；
 *      区间表在内容高度/宽度变化后重建（节流）。
 *   4. 查表：吸顶条 = 最后一条 start + BAR_HEIGHT <= scrollTop 的 user 消息
 *      （上边框进入吸顶条槽位，与固定住的顶部同一位置）。
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
const CHECK_INTERVAL_MS = 400; // 内容/宽度变化检测
const REBUILD_DELAY_MS = 120; // 重建区间表的节流（越短越不容易用到旧表）
const BAR_HEIGHT = 3; // 吸顶条气泡高度（首行截断单行 → 恒 3 行：pad+内容+pad）

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
 * 吸顶条组件：复用 transcript 内用户消息（UserMessageComponent）的渲染管线，
 * 气泡底色 userMessageBg + 正文 userMessageText + markdown 主题色全部惰性解析，
 * 主题切换后 render 通过主题指纹（fingerprint）自动重建、跟随新主题。
 * 高度恒定 3 行（空态也占 3 行），避免吸顶条出现/消失引起视口跳动。
 * 内容取 user 消息首行并截断到单行。
 */
class AffixPromptBar {
  private text = "";
  private cached: string[] | undefined;
  private cachedWidth: number | undefined;
  private cachedFp: string | undefined;
  hasContent = false;
  lastWidth = 0;

  constructor(private readonly getUi: () => ExtensionUIContext | undefined) {}

  setText(text: string): void {
    this.text = text;
    this.hasContent = text.length > 0;
    this.cached = undefined;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /** 主题指纹：render 时比对，主题切换后返回不同字符串 → 触发重建跟随新主题 */
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
    this.lastWidth = width; // 供测量使用
    if (!this.hasContent || width < 1) return []; // 空态 0 行，不占位
    const fp = this.fingerprint();
    let lines = this.cached;
    if (!lines || this.cachedWidth !== width || this.cachedFp !== fp) {
      this.cachedWidth = width;
      this.cachedFp = fp;
      try {
        // 复用 transcript 用户消息渲染；文本先截断保证单行（气泡恒 3 行）。
        // OSC133 标记会在 layout 绘制时被剥离。
        const singleLine = truncateToWidth(this.text, Math.max(4, width - 4));
        lines = new UserMessageComponent(singleLine).render(width);
        if (lines.length === 0) lines = ["", "", ""];
      } catch {
        lines = ["", "", ""];
      }
      this.cached = lines;
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;
  let capturedTui: AltScreenLike | undefined;
  let enabled = loadEnabled();
  let timer: ReturnType<typeof setInterval> | undefined;

  const bar = new AffixPromptBar(() => ui);
  (bar as any)[BAR_MARK] = true; // 布局里识别吸顶条的标记（/reload 后也能认出来）

  let index: UserMsg[] = []; // user 消息区间表 [start, end) × 文本
  let displayedText: string | undefined;
  let lastContentHeight: number | undefined;
  let lastWidth = 0;
  let lastMeasuredTotal = 0; // 最近一次测量的内容总行数（与 layout contentHeight 对比自检）

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
          newIndex.push({ start: offset, end: offset + h, text: raw.split("\n")[0] ?? "" });
        }
        offset += h;
      }
    }
    index = newIndex;
    lastMeasuredTotal = offset;
    dlog(
      `rebuild width=${width} total=${offset} contentHeight=${sv.contentHeight} msgs=${newIndex.length}`,
      newIndex.map((m) => `[${m.start},${m.end}]`).join(" "),
    );
  }

  /**
   * 查表：吸顶条 = 最后一条「上边框已进入吸顶条槽位」的 user 消息
   * （start + BAR_HEIGHT <= scrollTop）。第一个消息例外：初始时上方占位为空，
   * 上沿碰触视口顶部（start <= scrollTop）即触发。
   * 底部短回答场景（最后一条消息仍可见）置空：原文就在屏幕上。
   */
  function refreshAffix(): void {
    if (!enabled) return;
    const sv = getTranscript();
    if (!sv || index.length === 0) return;
    const st = typeof sv.scrollTop === "number" ? sv.scrollTop : 0;
    const contentHeight = sv.contentHeight ?? 0;
    const viewportHeight = sv.viewportHeight ?? 0;
    const maxSt = Math.max(0, contentHeight - viewportHeight);
    const last = index[index.length - 1];

    let current: UserMsg | undefined;
    for (let i = 0; i < index.length; i++) {
      const m = index[i];
      // 第一个消息：初始时吸顶条尚未占位（0 行），上沿碰触视口顶部即触发；
      // 后续消息：需滚入吸顶条槽位（与固定住的顶部同一位置）才切换
      const offset = i === 0 ? 0 : BAR_HEIGHT;
      if (m.start + offset <= st) current = m;
      else break;
    }
    // 底部 + 最后一条消息仍贴住视口顶部 → 置空（原文可见，不重复不误导）
    if (st >= maxSt - 1 && last && last.start <= st && last.end > st) {
      current = undefined;
    }

    const text = current ? current.text : "";
    if (text !== displayedText) {
      const wasEmpty = !displayedText; // 空 → 非空：首次固定
      displayedText = text;
      bar.setText(text);
      // 首次固定：bar 从 0 行变 BAR_HEIGHT 行会把视口内容压下去相同距离，
      // 同步把 scrollTop 上调，让刚触发的消息留在原位（滑入 bar 槽位被盖住），
      // 避免 bar 与原文紧挨着出现两份
      if (wasEmpty && current && typeof sv.scrollTo === "function") {
        sv.scrollTo(st + BAR_HEIGHT);
      }
      capturedTui?.requestRender?.();
      dlog(
        `pin scrollTop=${st} -> ${current ? `[${current.start},${current.end}] ${JSON.stringify(text)}` : "(空)"}${wasEmpty && current ? ` scrollTo=${st + BAR_HEIGHT}` : ""} contentHeight=${contentHeight} viewport=${viewportHeight}`,
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    captureTui(ctx.ui);
    ensureBarInLayout();
    if (!timer) {
      timer = setInterval(() => {
        // 内容/宽度变化 → 重建；否则仅查表（滚动由 hook 即时处理）
        const sv = getTranscript();
        if (enabled && sv) {
          const ch = sv.contentHeight;
          // 内容/宽度变化，或测量总额与布局 contentHeight 漂移 → 重建自检
          if (ch !== lastContentHeight || bar.lastWidth !== lastWidth || ch !== lastMeasuredTotal) {
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
    lastMeasuredTotal = 0;
    displayedText = undefined;
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
        bar.setText("");
        displayedText = undefined;
        index = [];
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
