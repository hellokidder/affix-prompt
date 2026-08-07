# affix-prompt

pi 扩展：transcript 中「用户输入消息」的 Affix 吸顶（类似 antd Affix）。

## 功能（v0.0.3：所有 user 消息统一的「剥落 + 接管」模型）

- **每条 user 消息一视同仁**：触顶 → 剥落（固定副本 = 该消息真实渲染行的前 h 行，
  `h = clamp(scrollTop − start, 0, H)`）→ 完全吸顶（与渲染组件同高同内容）→
  被下一条消息接管。首条消息只是「无前驱」的特例。
- **前进接管**：下一条消息顶滚入 pin 高度（`scrollTop ≥ start_{i+1} + H_i`）时，
  pin 切换为下一条消息，高度连续（h 恰好 = H_i）；仅当下一条更矮时才需要补偿。
- **后退交回**：当前消息顶回落视口顶以下（`scrollTop < start_i`，剥落完全坍缩）时，
  pin 换回上一条全高。前进/后退边界不同 → 状态式迟滞，补偿回越不触发乒乓。
- **固定副本与 TUI 渲染组件同高同内容**：直接复用消息组件的实时渲染
  （live UserMessageComponent，同宽同主题），不同高度的消息天然按各自真实高度吸顶。
- **无跳动、无抽搐**：吸顶高度在渲染时由当前 scrollTop 即时派生（同帧对齐，
  无 1 帧滞后）；接管/交回的高度变化在 render 内 `scrollTo(st + Δ)` 同帧补偿
  （pi 布局的 translateBox 在 updateLayout 之后执行 → 内容同一帧校正）。
- 怪物 prompt（消息高度超过屏幕）封顶，给 transcript 保底 2 行。

## 行为细节

- 触顶边界：`scrollTop = start`（该消息上沿碰触 TUI 上沿），开始剥落。
- 吸顶高度：`h = clamp(scrollTop − start_active, 0, H_active)`。
- 前进接管：`scrollTop ≥ start_{i+1} + H_i`（下一条消息顶滚出整个 pin 高度）。
- 后退交回：`scrollTop < start_i`（当前消息顶回到视口顶以下）。
- v0.0.1/v0.0.2 的「缩略单行 pin」「底部短回答置空」已删除（统一模型不再需要）。

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
