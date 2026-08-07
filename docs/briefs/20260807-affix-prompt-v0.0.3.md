# Agent Task Brief — affix-prompt v0.0.3：所有 user 消息统一的「剥落 + 接管」模型

## Title

把 v0.0.2「仅首条消息」的剥落模型推广到所有 user 消息：每条消息触顶剥落、完全吸顶（同高）、被下一条接管；接管/交回用状态式迟滞 + 同帧补偿，内容零跳动。

## Background

v0.0.2 只实现了首条 user 消息的剥落/坍缩；后续消息仍走 v0.0.1 遗留的 3 行截断 pin（离散切换 + 模式复杂）。用户要求：非首 user 消息的固定逻辑、更顺滑、且每条高度可能不同（应按各自真实高度吸顶）。

## Goal

- **统一模型**：所有 user 消息同一套规则（首条 = 无前驱特例）。吸顶条显示「当前消息」的 live 组件渲染行前 h 行（`h = clamp(scrollTop − start_active, 0, H_active)`），完全吸顶时与渲染组件同高同内容。
- **前进接管**：`scrollTop ≥ start_{i+1} + H_i`（下一条顶滚满 pin 高度）→ pin 切换，高度连续（h = H_i）；仅下一条更矮（`H_{i+1} < H_i`）时补偿。
- **后退交回**：`scrollTop < start_i`（当前消息顶回落视口顶以下）→ 换回上一条全高。
- **状态式迟滞**：前进/后退边界不同 → 补偿回越不触发乒乓（无需方向追踪）。
- **同帧补偿**：切换高度变化 Δ 在 render 内 `scrollTo(st + Δ)`（pi 布局 translateBox 在 updateLayout 后执行 → 同帧校正）。
- 删除 v0.0.1 缩略 pin（3 行截断）与 bottomClear 规则；删除 firstLines 缓存（改用 live 组件渲染）。

## Core Value Mapping

独立小仓库；对应 README 承诺「用户消息上沿触顶后固定在顶部吸顶条里」的完整化：从「仅首条」推广到全部，且每条按真实高度、切换零跳动。

## Non-goals

- **不**做栈式吸顶（所有消息永久堆叠；空间代价大，留作备选）。
- **不**做方向追踪迟滞（用状态式迟滞，实现更简单）。
- **不**改 poke-poke 本体、不动 pi 内部实现。
- **不**引入新配置项（沿用 `~/.pi/agent/affix-prompt.json`）。

## Owned Files

- `index.ts`（状态机 + live 组件渲染 + 同帧补偿）
- `package.json`（0.0.2 → 0.0.3）
- `README.md`
- `docs/briefs/20260807-affix-prompt-v0.0.3.md`（本 brief）

## Read-only Files

- `@earendil-works/pi-tui` 的 `layout.js`（translateBox 时序，验证同帧补偿）
- `@earendil-works/pi-coding-agent` 的 `user-message.js`（组件渲染管线）

## Forbidden Files

- `~/.pi/agent/extensions/affix-prompt/` 是到本仓库的符号链接，不单独改
- pi 本体任何文件

## Acceptance Criteria

- [ ] 多条不同高度的 user 消息：逐条触顶剥落 → 完全吸顶（同高同内容）→ 被下一条接管
- [ ] 接管/交回时内容位置零跳动（同帧补偿 + 状态式迟滞，无乒乓）
- [ ] 后退级联（深滚后回滚：3→2→1→0）连续
- [ ] PageUp/PageDown 跳跃滚动收敛正确（级联逐帧补偿）
- [ ] `pnpm typecheck` 通过
- [ ] 真人 smoke（README 手工 smoke 5 步）

## Risks

- **同帧补偿**依赖 pi 布局顺序（bar 先量高 → scrollTo → transcript 后 layout 读新 scrollTop），已在 layout.js 核对；若 pi 布局变动需重新验证。
- **状态机收敛**：跳跃滚动时每帧最多前进/后退一步（级联补偿）；极端快速输入下 pin 需数帧收敛，期间内容不动（补偿吸收）。
- **怪物 prompt 封顶**：接管边界仍用未封顶 H_i，封顶后 pin 高度与接管点几何略松，可接受。

## Verification

- [x] `pnpm typecheck`（poke-poke 的 tsc 跑本仓库 tsconfig）
- [x] 状态机模拟：下滚/上滚/回滚/变速/大步/跳跃全场景内容连续、无乒乓（模拟脚本已跑）
- [ ] 手工 smoke（/reload 后按 README 步骤）

## Notes

- 首条消息行为与 v0.0.2 一致（接管公式中 H_0 = 0 退化为触顶即剥落）。
- 后续如需「所有问题常驻可见」可切栈式模型（备选方案，几何完全连续但占空间）。

---

## Changed Files（完成时回填）

- `index.ts`
- `package.json`
- `README.md`
- `docs/briefs/20260807-affix-prompt-v0.0.3.md`
