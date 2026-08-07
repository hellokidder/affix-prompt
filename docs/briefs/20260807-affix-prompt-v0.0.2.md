# Agent Task Brief — affix-prompt v0.0.2：首个 user 消息全高「剥落式」吸顶

> 仓库：`affix-prompt`（独立小仓库，非 poke-poke 本体）。本 brief 复制自 poke-poke 的模板并裁剪为本仓库适用。

## Title

v0.0.2：固定的 user prompt component 与 transcript 内渲染组件**同高同内容**（不再是 v0.0.1 的缩略单行），并实现「每个对话第 1 条 user 消息」的剥落式吸顶/坍缩逻辑。

## Background

v0.0.1 的吸顶条固定 3 行、内容截断单行（缩略态）。v0.0.2 要求：

1. 固定组件高度与 TUI 中渲染的组件高度一致（完整内容，非缩略）；
2. 针对**每个对话的第 1 条 user 消息**实现滚动吸顶/坍缩：
   - 向上滚动（内容上移）：以该消息上沿碰触 TUI 上沿为界；继续上滚则顶部出现固定副本，高度 = 该消息渲染高度 H（上限），并随滚出距离增长（h = clamp(scrollTop - start, 0, H)）；
   - 向下滚动：已有固定副本时，以「渲染中的 component 下沿」与「固定的 component 下沿」为界；继续下滚则固定高度 1:1 坍缩回 0。

## Goal

- 重构吸顶条为**动态高度**（0..H），内容复用 transcript 内该消息的**真实渲染行**（同宽同主题），保证「同高同内容」。
- 首条 user 消息的 reveal 模型：`h = clamp(scrollTop - start, 0, H)`，部分吸顶显示前 h 行，完全吸顶高度 = H。
- 通过「h 与 scrollTop 1:1 联动」实现内容自锚定（原文下方内容冻结，滚动输入被吸顶高度吸收），reveal 过程无跳动、无需补偿。
- 后续消息（第 2 条起）保留 v0.0.1 的缩略吸顶（3 行），仅在首条完全吸顶后滚动足够深时接管；接管/交回为离散高度变化，做一次 scrollTop 补偿。

## Core Value Mapping

独立小仓库，不适用 poke-poke 的 product-spec 引用；对应 README 承诺的「用户消息上沿触顶后固定在顶部吸顶条里」的完整化，并把「缩略态」升级为「同高同内容」。

## Non-goals

- **不**把 reveal 模型推广到后续消息（后续消息仍用 v0.0.1 缩略吸顶，避免一次任务跨度过大）。
- **不**改 poke-poke 本体、不动 pi 内部实现。
- **不**做 overlay 方案（经分析：overlay 会遮挡 transcript 顶层内容，只有「布局内占位 + 动态高度」才能让固定副本与原文无缝拼接）。
- **不**引入配置文件/设置项变更（沿用 `~/.pi/agent/affix-prompt.json`）。

## Owned Files

- `index.ts`（全部逻辑，重写吸顶条类 + refreshAffix + rebuildIndex）
- `package.json`（版本 0.0.1 → 0.0.2）
- `README.md`（行为描述同步）
- `docs/briefs/20260807-affix-prompt-v0.0.2.md`（本 brief）

## Read-only Files

- `@earendil-works/pi-tui` 的 `scroll-view.js` / `layout.js` / `components/box.js` / `components/stack.js`（仅读，验证布局语义）
- `@earendil-works/pi-coding-agent` 的 `modes/interactive/components/user-message.js`、`interactive-mode.js`（仅读，确认 UserMessageComponent 实例化参数与 transcript 结构）

## Forbidden Files

- `~/.pi/agent/extensions/affix-prompt/` 是到本仓库的符号链接，不单独改
- pi 本体任何文件

## Acceptance Criteria

- [ ] 首条 user 消息上沿碰触 TUI 上沿后，顶部出现与其**同高同内容**的固定副本；继续上滚，固定副本高度 = 滚出距离，封顶 H
- [ ] 固定副本显示该消息的真实渲染行（前 h 行），完全吸顶时与 transcript 渲染逐行一致
- [ ] 向下滚动，固定副本 1:1 坍缩回 0，回到原文，全程内容无跳动
- [ ] 第 2 条起的消息仍走 v0.0.1 缩略吸顶；与 reveal 交接时内容不跳动（scrollTop 补偿）
- [ ] 后续消息吸顶时保留 v0.0.1 的「底部短回答置空」规则
- [ ] `pnpm typecheck` 通过（用 poke-poke 的 tsc 跑本仓库 tsconfig）
- [ ] 真人 smoke：`/reload` 后上下滚动验证剥落/坍缩/交接

## Risks

- **布局反馈环**：followingEnd（贴底）时 scrollTop 随 viewport 变化，与 h 联动可能逐帧漂移；经推导在 K>start0 时收敛到全吸顶、K<start0 时收敛到 0（无无限循环），残余为到达底部瞬间几帧的渐变。
- **1 帧滞后**：bar 高度用上一帧 scrollTop（布局先量 bar 后跑 updateLayout），滚动中最大差 1 行/帧，不可感知。
- **怪物 prompt**：消息高度超过屏幕时 reveal 封顶（viewportHeight - 2），给 transcript 保底 2 行；封顶后锚定让位于普通滚动。
- **主题切换**：reveal 缓存行依赖主题，400ms 轮询指纹重建。

## Verification

- [x] `pnpm typecheck`（`poke-poke/node_modules/.bin/tsc --noEmit -p affix-prompt/tsconfig.json`）
- [ ] 手工 smoke（`/reload` 后滚轮上下 + 大屏/小屏 + 长首条消息）

## Notes

- 交互式 TUI 无法在本会话自动 e2e；验收依赖真机 smoke，已把步骤列在 README「调试」节。
- 后续版本把 reveal 模型推广到后续消息时，本 brief 的「接管补偿」逻辑可整体移除。
- v0.0.2 提交后补充修复「固定节点抽搐」：目标状态改为渲染时即时派生（同帧读当前
  scrollTop），消除布局先量吸顶条、后跑 updateLayout 的 1 帧滞后（滚动时接缝误差
  可达每个事件的行数）；pin 接管边界改用上一帧实际渲染高度做迟滞，避免补偿回越
  导致模式乒乓。几何模拟验证：剥落区接缝误差旧模型最大 4 行 → 新模型 0。

---

## Changed Files（完成时回填）

- `index.ts`
- `package.json`
- `README.md`
- `docs/briefs/20260807-affix-prompt-v0.0.2.md`
