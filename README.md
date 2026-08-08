# affix-prompt

pi 扩展：transcript 中「用户输入消息」的 Affix 吸顶（类似 antd Affix）。

## 功能（v0.0.2：所有 user 消息统一的「剥落 + 渐进交回」模型）

- **每条 user 消息一视同仁**：触顶 → 剥落（固定副本 = 该消息真实渲染行的前 h 行，
  `h = clamp(scrollTop − start, 0, H)`）→ 完全吸顶（与渲染组件同高同内容）→
  接近下一条时渐进让位。首条消息只是「无前驱」的特例。
- **渐进三角（pin 永不盖住任何问题）**：`pin 高度 = min(剥落量, 到下一个问题的距离)`。
  pin 底永不越过下一个问题的顶——**短问题及其回答全程可见**：
  - 上滚（回看）：上一条的 pin 从 0 随滚动 1:1 长到 H（渐进交回，不再瞬间盖住短问题）
  - 下滚：pin 在接近下一条时逐渐缩没让位（不再盖住下一个问题的顶部）
- **前进/后退边界对称（触顶即切换）**，切换点高度连续 → 正常路径零补偿、零乒乓；
  大跳（PageUp/PageDown）级联逐帧收敛，防御性补偿兜底。
- **固定副本与 TUI 渲染组件同高同内容**：直接复用消息组件的实时渲染
  （live UserMessageComponent，同宽同主题），不同高度的消息天然按各自真实高度吸顶。
- **无跳动、无抽搐**：吸顶高度在渲染时由当前 scrollTop 即时派生（同帧对齐，
  无 1 帧滞后）。
- 怪物 prompt（消息高度超过屏幕）封顶，给 transcript 保底 2 行。

## 行为细节

- 触顶边界：`scrollTop = start`（该消息上沿碰触 TUI 上沿），开始剥落。
- 吸顶高度：`h = min(clamp(scrollTop − start_active, 0, H_active), start_next − scrollTop)`。
- 前进接管：`scrollTop ≥ start_{k+1}`（下一条触顶即接管）。
- 后退交回：`scrollTop < start_k`（当前消息顶回到视口顶以下）。
- v0.0.1 的「缩略单行 pin」「底部短回答置空」已删除（统一模型不再需要）。

## 两种模式

- **自然模式**（默认，`/affix-prompt natural`）：完整内容剥落 + 渐进交回（上文所述全部行为）。
- **One line 模式**（`/affix-prompt oneline`）：v0.0.1 风格的单行缩略气泡（恒 3 行）——
  吸顶条显示「最后一条上沿滚入槽位」的 user 消息首行截断；第一条触顶即触发；
  底部短回答场景（最后一条消息仍可见）置空；出现/消失做 scrollTop 补偿。

模式保存在 `~/.pi/agent/affix-prompt.json`（`{ "enabled": true, "mode": "natural" }`），跨会话记忆。

## 安装

放在 `~/.pi/agent/extensions/affix-prompt/index.ts`（子目录自动发现），`/reload` 生效。

## 用法

```
/affix-prompt             切换 开/关
/affix-prompt on|off      开启/关闭
/affix-prompt natural     自然模式（完整内容剥落 + 渐进交回）
/affix-prompt oneline     One line 模式（单行缩略）
```

状态保存在 `~/.pi/agent/affix-prompt.json`，跨会话记忆。

## 调试

```bash
POKEPOKE_AFFIX_DEBUG=1 pi
```

日志写入 `/tmp/affix-prompt-debug.log`（rebuild 测量值 vs contentHeight、状态机切换
与补偿 Δ）。

## 手工 smoke（改版后必做）

1. `/reload` 后进入 fullscreen TUI，发两条不同长度的 prompt（一短一长），等回复。
2. 向上滚动：prompt 触顶 → 剥落 → 完全吸顶（同高同内容）；继续滚到第二条 prompt 顶：
   pin 接管为第二条（接管瞬间内容不跳动，pin 高度连续）。
3. 向下滚动：第二条剥落坍缩 → 交回第一条全高（内容不跳动）。
4. 三条及以上 prompt、不同高度组合各试一次；PageUp/PageDown 跳跃滚动试一次。
5. 小屏/大屏、超长首条消息各试一次。

## 开发

```bash
pnpm typecheck   # 需在 node_modules 里有 pi 类型（见 tsconfig 注释）
```
