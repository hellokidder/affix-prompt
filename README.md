# affix-prompt

pi 扩展：transcript 中「用户输入消息」的 Affix 吸顶（类似 antd Affix）。

## 功能（v0.0.2）

- **每个对话第 1 条 user 消息的「剥落式」吸顶**：向上滚动（内容上移）到该消息上沿碰触
  TUI 上沿后，顶部出现固定副本；继续上滚，固定副本高度 = 滚出上沿的距离（封顶 = 消息
  真实渲染高度 H）；向下滚动则 1:1 坍缩回 0，回到原文。
- **固定副本与 TUI 渲染组件同高同内容**：直接复用 transcript 内该消息的真实渲染行
  （同宽同主题），不再是 v0.0.1 的缩略单行；完全吸顶时高度与原文逐行一致。
- **无跳动**：吸顶高度与 scrollTop 同步联动，原文下方内容冻结在屏幕固定位置，
  滚动输入被完全吸收进吸顶高度；剥落/坍缩全程内容不移动。
- 后续消息（第 2 条起）保留 v0.0.1 的缩略吸顶（3 行截断），在首条完全吸顶后滚动
  足够深时接管；接管/交回自动做 scrollTop 补偿，内容不跳动。
- 底部短回答场景（最后一条消息仍可见）后续消息吸顶置空（v0.0.1 规则）。

## 行为细节

- 触顶边界：`scrollTop = start`（该消息上沿碰触 TUI 上沿）。
- 吸顶高度：`h = clamp(scrollTop - start, 0, H)`，H = 该消息渲染行数。
- 完全吸顶：`scrollTop ≥ end` 时 `h = H`，固定副本高度与渲染组件一致。
- 坍缩边界：渲染中组件下沿与固定组件下沿相齐（`scrollTop = end`）后继续下滚，
  固定高度 1:1 坍缩，`scrollTop = start` 时归零回到原文。
- 消息高度超过屏幕（怪物 prompt）时吸顶高度封顶，给 transcript 保底 2 行。

## 安装

放在 `~/.pi/agent/extensions/affix-prompt/index.ts`（子目录自动发现），`/reload` 生效。

## 用法

```
/affix-prompt       切换 开/关
/affix-prompt on    开启
/affix-prompt off   关闭
```

状态保存在 `~/.pi/agent/affix-prompt.json`，跨会话记忆。

## 调试

```bash
POKEPOKE_AFFIX_DEBUG=1 pi
```

日志写入 `/tmp/affix-prompt-debug.log`（rebuild 测量值 vs contentHeight、状态机切换与
补偿 Δ）。

## 手工 smoke（改版后必做）

1. `/reload` 后进入 fullscreen TUI，开一个新对话，发一条多行 prompt，等回复。
2. 向上滚动：prompt 上沿触顶 → 顶部出现与原文同高的固定副本；继续上滚，副本随滚出
   距离增长，原文其余部分不动；完全滚过后副本 = 整条 prompt。
3. 向下滚动：副本 1:1 坍缩回 0，回到原文，全程内容无跳动。
4. 滚动到第 2 条 user 消息之后：副本切换为缩略态（3 行）；回滚时交回，无跳动。
5. 小屏/大屏、长首条消息各试一次。

## 开发

```bash
pnpm typecheck   # 需在 node_modules 里有 pi 类型（见 tsconfig 注释）
```
