# Agent Task Brief — affix-prompt v1.0.0：统一模型（剥落 + maxRows 限高）正式发版

## Title

v1.0.0 正式版：natural 与 oneline 统合为单一「剥落 + maxRows 限高」模型，纯函数状态机 + 确定性单测，发版文档/许可/仓库就绪。

## Background

v0.0.x 期间经历了多次模型迭代（首条剥落 → 全量剥落 + 渐进三角 → 移除渐进三角 + 接管迟滞），
并在此过程中发现并修复了两个结构性缺陷：

- **渐进三角锁死**：`h = min(剥落量, next.start − st)`（斜率 −1）与底部跟随
  （`st = maxScrollTop = C − TOTAL + h`）合成 `st = f(st)` 且 `|f′| = 1` → 2 周期振荡 +
  st 天花板——超长消息的三角区间会把向下滚动锁死（v0.0.3 移除）。
- **接管/交回乒乓**：接管帧高度跳变的同帧补偿会把 st 移到交回区 → 交回补偿弹回 →
  无限乒乓（用「接管迟滞 takeoverDrop」修复：相对量跳变，内容变化后仍随新 start 生效）。

v1.0.0 将两种模式预设（natural/oneline）收敛为一个数字 `maxRows`（内容行数语义），
并完成发版工程化（自包含类型环境、双语 README、LICENSE、测试套件）。

## Goal

- **统一模型**：所有 user 消息同一套规则；`maxRows`（内容行数）控制 pin 显示行数，
  pin 总高 = maxRows + 2（上下 pad 后台补）；`maxRows = 0` 完整模式。
- **纯函数状态机**（`state-machine.ts`）：`deriveNaturalTarget` + `anchorActive`，
  零 pi 依赖、确定性单测（27 用例）。
- **性能**：render 输出缓存（静止零渲染）+ 组件全量行缓存（滚动只 slice）+
  增量重建（WeakMap）+ chat 容器引用缓存 + 自检收敛 guard。
- **发版就绪**：自包含 devDependencies（npm install 后 typecheck 可跑）、
  双语 README（英文默认）、MIT LICENSE、`engines: node >= 21`。

## Non-goals

- 不做栈式吸顶（所有消息永久堆叠）。
- 不引入方向追踪迟滞（用接管迟滞 takeoverDrop）。
- 不改 poke-poke 本体、不动 pi 内部实现。

## Owned Files

- `index.ts`（pi 集成：布局 hook、补偿、命令、缓存）
- `state-machine.ts`（纯函数状态机）
- `tests/derive-target.test.ts`（27 个确定性用例）
- `package.json` / `tsconfig.json` / `LICENSE` / `.gitignore`
- `README.md`（英文主页）/ `README.zh-CN.md`
- `docs/briefs/20260807-affix-prompt-v1.0.0.md`（本 brief）

## Read-only Files

- `@earendil-works/pi-tui` 的 `layout.js` / `scroll-view.js`（补偿时序、clamp、只读性）
- `@earendil-works/pi-coding-agent` 的 `user-message.js` / `interactive-mode.js`（组件结构）

## Acceptance Criteria

- [x] `npm install && npm run typecheck && npm test` 在干净环境下通过（自包含）
- [x] 27/27 确定性单测（剥落/接管/交回迟滞/级联/怪物封顶/maxRows/重锚定/回归）
- [x] 双语 README（默认英文）+ MIT LICENSE + engines
- [x] `state-machine.ts` 纯函数、无 pi 依赖
- [x] 性能：静止零渲染（500 行消息实测 ~685x）、滚动只 slice（~534x）

## Verification

- [x] `npm run typecheck`（自包含 devDeps）
- [x] `npm test`（27/27）
- [x] 帧循环模拟：超长消息 + 底部跟随不锁死、接管点不乒乓、reload 冷启动重锚定不窜
- [x] 10 个社区主题兼容性验证（渲染健康检查 + 省略号颜色修复）
- [ ] 真机 smoke（README 手工步骤）

## Notes

- `maxRows` 语义 = 内容行数（用户可见）；pin 总高 = maxRows + 2（后台补 pad）。
- 旧状态文件自动迁移：`mode: oneline` → `maxRows: 1`；v0.1.0 总行数语义 − 2。
- 已知取舍：缩略模式对称气泡的上下 pad 占 2 行（内容区 = maxRows 行）。

---

## Changed Files（完成时回填）

- `index.ts` / `state-machine.ts` / `tests/` / `package.json` / `tsconfig.json`
- `README.md` / `README.zh-CN.md` / `LICENSE`
- `docs/briefs/20260807-affix-prompt-v1.0.0.md`
