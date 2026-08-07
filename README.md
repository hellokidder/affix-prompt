# affix-prompt

pi 扩展：transcript 中「用户输入消息」的 Affix 吸顶（类似 antd Affix）。

## 功能

- fullscreen TUI 模式下，用户消息（UserMessageComponent）上沿触顶后固定在顶部吸顶条里
- 吸顶条复用终端内用户消息的渲染管线（`userMessageBg` / `userMessageText` / markdown 主题色），跟随主题
- 切换时机：下一条消息上边框滚入吸顶条槽位（与固定住的顶部同一位置）才变更
- 首个消息特殊处理：初始上方无占位，上沿碰触视口顶部即触发；触发同时 scrollTop 同步补偿，消息无缝滑入槽位，不出现两份
- 空态不占位（0 行），不影响整体布局
- 底部短回答场景（最后一条消息仍可见）吸顶条置空

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

日志写入 `/tmp/affix-prompt-debug.log`（rebuild 测量值 vs contentHeight、pin 时机与补偿）。

## 开发

```bash
pnpm typecheck   # 需在 node_modules 里有 pi 类型（见 tsconfig 注释）
```
