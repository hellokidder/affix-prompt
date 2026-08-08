# affix-prompt

**pi 编码 Agent 的「用户消息 Affix 吸顶」扩展** —— 滚动时把当前用户消息（你的 prompt）固定在 transcript 顶部（仅支持 fullscreen TUI 模式）。

[English](../README.md) | [中文](README.zh-CN.md)

---

## 功能

长对话里向上滚动时，你自己的 prompt 会滚出视野，容易忘记问过什么。**affix-prompt** 把当前用户消息固定在 transcript 顶部：

- **剥落吸顶** —— 消息顶部滚出屏幕时，滚出的部分以 1:1 的方式「剥落」进吸顶条；完全滚出后，吸顶条显示完整消息——同高、同内容、同主题。
- **前进接管** —— 下一条用户消息触顶时吸顶条无缝切换（高度跳变由同帧滚动补偿吸收，内容位置不跳动）。
- **后退交回** —— 向上滚回时交还给上一条消息，带迟滞防接管边界的振荡。
- **可选缩略** —— 设置内容行数上限（`maxrows N`），吸顶条显示前 N 行内容（带对称边框）而非完整消息。

吸顶条是**消息组件的实时渲染**（同主题、同宽度、同 markdown 样式）——不硬编码任何颜色，兼容所有 pi 主题。

## 环境要求

- pi ≥ 0.84
- **目前仅支持 fullscreen TUI 模式**（`--tui-mode fullscreen` 或 `/settings` 里切换）。
  普通模式（终端回滚）没有可用的布局系统，扩展在其中不会生效
  （设置仍会保存，切回 fullscreen 后自动生效）。

## 安装

### 推荐：从 npm 安装（pi 包画廊）

```bash
pi install npm:affix-prompt
```

然后在 pi 里执行 `/reload`（或重启 pi）。后续更新：`pi update npm:affix-prompt`。

### 从 git 安装

```bash
pi install git:github.com/hellokidder/affix-prompt@v1.0.0
```

### 手动 / 开发模式

克隆或复制本仓库到 pi 扩展目录（适合开发调试时）：

```bash
mkdir -p ~/.pi/agent/extensions
# 方式 A：克隆仓库
git clone https://github.com/hellokidder/affix-prompt ~/.pi/agent/extensions/affix-prompt
# 方式 B：复制源码
#   把 index.ts 和 state-machine.ts 复制到 ~/.pi/agent/extensions/affix-prompt/
# 方式 C：符号链接本地开发目录（改完 /reload 即同步）
#   ln -s /path/to/affix-prompt ~/.pi/agent/extensions/affix-prompt
```

## 用法

```
/affix-prompt              切换 开/关
/affix-prompt on|off       开启/关闭
/affix-prompt maxrows N    设置内容行数上限（pin 显示 N 行内容，总高 N+2）
/affix-prompt 5            「maxrows 5」的快捷写法
/affix-prompt 0            完整模式（不缩略，默认）
```

- **`maxrows 0`**（默认）：完整模式——吸顶条长到消息完整高度。
- **`maxrows N`**（N ≥ 1）：缩略模式——吸顶条显示前 N 行内容，上下带对称 padding 边框（紧凑气泡）。`maxrows 1` 即单行气泡。

设置跨会话保存在 `~/.pi/agent/affix-prompt.json`：

```json
{ "enabled": true, "maxRows": 0 }
```

> `maxRows` 是**内容行数**；吸顶条总高 = `maxRows + 2`（上下 padding 由后台处理）。
>
> **默认行为**：扩展**默认开启**（`maxRows: 0` 完整模式）——安装后首次进入 fullscreen 模式即生效。可用 `/affix-prompt off` 关闭。

## 行为细节

- **剥落边界**：`scrollTop = start`（消息上沿碰触 TUI 上沿）时吸顶条开始生长。
- **吸顶高度**：`h = clamp(scrollTop − start, 0, min(H, maxRows + 2, totalSpace − 2))`——H 为消息渲染高度，`totalSpace − 2` 给 transcript 保底 2 行（怪物 prompt 保护）。
- **前进接管**：`scrollTop ≥ start_next`——下一条消息接管吸顶条；切换帧的高度跳变由同帧 `scrollTo` 补偿吸收，内容位置连续。
- **后退交回**：`scrollTop < start − takeoverDrop`（迟滞）——防止接管边界的乒乓振荡。

## 主题

吸顶条通过 pi 自己的 `UserMessageComponent` 渲染，颜色始终来自**当前 pi 主题**（`userMessageBg`、`userMessageText`、`md*` 等 token）。没有任何颜色硬编码——切换主题后吸顶条自动跟随。任何通过 pi schema 校验的主题都兼容。

## 已知限制

- **怪物 prompt**（消息比屏幕还高）：吸顶条封顶在 `totalSpace − 2` 行，保证 transcript 始终可见 ≥ 2 行。
- **缩略模式**（`maxrows N` < 消息高度）：上下对称边框占 2 行，吸顶条显示 N 行内容，其余部分在下方 transcript 里滚动。
- **图片**：消息内联终端图片在吸顶条中没有特殊处理（罕见——用户消息的 markdown 通常不渲染图片）。

## 调试

```bash
AFFIX_PROMPT_DEBUG=1 pi
```

日志写入 `/tmp/affix-prompt-debug.log`（重建测量值、状态机切换、补偿 Δ）。

## 开发

```bash
node --test "tests/**/*.test.ts"   # 状态机单测（无需 pi 运行时）
```

状态机在 `state-machine.ts` 中，是带确定性单测的纯函数；`index.ts` 是 pi 集成层（布局 hook、滚动补偿、命令）。

## License

MIT
