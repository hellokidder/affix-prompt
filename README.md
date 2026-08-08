# affix-prompt

**Affix pinned prompts for the pi coding agent** — keeps the current user message (your prompt) pinned at the top of the transcript while you scroll (fullscreen TUI mode only).

[English](README.md) | [中文](README.zh-CN.md)

---

## What it does

When you scroll up through a long conversation, your own prompts scroll out of view and you lose track of what was asked. **affix-prompt** pins the active user message to the top of the transcript:

- **Peel & stick** — as the message scrolls off the top, its off-screen lines are "peeled" into the pin, 1:1 with the scroll. Once fully scrolled off, the pin shows the complete message — same height, same content, same theme.
- **Takeover** — when the next user message reaches the top, the pin switches to it seamlessly (height jumps are absorbed by a same-frame scroll compensation, so content never jumps).
- **Hand-back** — scroll back up and the pin hands back to the previous message, with hysteresis to prevent oscillation at takeover boundaries.
- **Optional truncation** — set a max content-row limit (`maxrows N`); the pin then shows the first N content lines (with padding borders) instead of the full message.

The pinned copy is a **live render of the real message component**, so it always matches the current theme, width, and markdown styling — no hardcoded colors, works with any pi theme.

## Requirements

- pi ≥ 0.84
- **Only the fullscreen TUI mode is supported** (`--tui-mode fullscreen` or via `/settings`).
  The regular mode (terminal scrollback) has no layout system to pin into — the extension
  is inert there (settings still persist and take effect when you switch back to fullscreen).

## Installation

### Recommended: install from npm (pi package gallery)

```bash
pi install npm:affix-prompt
```

Then run `/reload` in pi (or restart pi). To update later: `pi update npm:affix-prompt`.

### From git

```bash
pi install git:github.com/hellokidder/affix-prompt@v1.0.0
```

### Manual / development

Clone or copy this repository into the pi extensions directory (useful when developing):

```bash
mkdir -p ~/.pi/agent/extensions
# Option A: clone the repository
git clone https://github.com/hellokidder/affix-prompt ~/.pi/agent/extensions/affix-prompt
# Option B: copy the source files
#   copy index.ts and state-machine.ts into ~/.pi/agent/extensions/affix-prompt/
# Option C: symlink a local checkout (auto-syncs on /reload)
#   ln -s /path/to/affix-prompt ~/.pi/agent/extensions/affix-prompt
```

## Usage

```
/affix-prompt               toggle on/off
/affix-prompt on|off        enable/disable
/affix-prompt maxrows N     set max content rows (pin shows N content lines, total height N+2)
/affix-prompt 5             shorthand for "maxrows 5"
/affix-prompt 0             full mode (no truncation, default)
```

- **`maxrows 0`** (default): full mode — the pin grows to the message's full height.
- **`maxrows N`** (N ≥ 1): truncation — the pin shows the first N content lines with symmetric padding borders (like a compact bubble). `maxrows 1` is a single-line bubble.

Settings persist across sessions in `~/.pi/agent/affix-prompt.json`:

```json
{ "enabled": true, "maxRows": 0 }
```

> `maxRows` is the number of **content lines**; the pin's total height is `maxRows + 2` (top/bottom padding is handled internally).
>
> **Default behavior**: the extension is **enabled by default** with `maxRows: 0` (full mode) — after installation it starts working the first time you enter fullscreen mode. Disable with `/affix-prompt off`.

## Behavior details

- **Peel boundary**: pin starts growing when `scrollTop = message.start` (message top touches the TUI top edge).
- **Pin height**: `h = clamp(scrollTop − start, 0, min(H, maxRows + 2, totalSpace − 2))` — where H is the message's rendered height and `totalSpace − 2` reserves at least 2 transcript rows (monster-prompt guard).
- **Takeover**: `scrollTop ≥ start_next` — the next message takes over the pin. Height jumps at handover are absorbed by a same-frame `scrollTo` compensation: content position stays continuous.
- **Hand-back**: `scrollTop < start − takeoverDrop` (hysteresis) — prevents ping-pong oscillation at the takeover boundary.

## Themes

The pin renders through pi's own `UserMessageComponent`, so colors always come from the **current pi theme** (`userMessageBg`, `userMessageText`, `md*` tokens). No color values are hardcoded — switching themes updates the pin automatically. Any theme that passes pi's schema validation works.

## Known limitations

- **Monster prompts** (taller than the screen): the pin caps at `totalSpace − 2` rows so the transcript always keeps ≥ 2 visible rows.
- **Truncation mode** (`maxrows N` < message height): the symmetric padding borders occupy 2 rows, so the pin shows `N` content lines; the remainder of the message scrolls in the transcript below.
- **Images**: user messages with inline terminal images are not specially handled in the pin (rare — user message markdown normally doesn't render images).

## Debugging

```bash
AFFIX_PROMPT_DEBUG=1 pi
```

Logs go to `/tmp/affix-prompt-debug.log` (rebuild measurements, state-machine transitions, compensation deltas).

## Development

```bash
node --test "tests/**/*.test.ts"   # state-machine unit tests (no pi runtime needed)
```

The state machine lives in `state-machine.ts` as pure functions with deterministic tests; `index.ts` contains the pi integration (layout hook, scroll compensation, command).

## License

MIT
