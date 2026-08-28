<div align="center">
  <h1>Claude Code Status Bar Monitor</h1>
  <p>A VS Code extension that displays real-time Claude Code usage statistics directly in your status bar.</p>
</div>

## However you run Claude Code

Tokens, cost, messages and per-session context are read from the transcripts, which
Claude Code writes the same way whichever way you start it — the **terminal CLI**,
the **Claude Code VS Code extension**, or both at once. Every running session is
listed, labelled by its project folder.

The one exception is the 5-hour and weekly limit percentages. Claude Code hands
those to a status line command, and its VS Code extension renders no status line,
so keep **one terminal session open** and those numbers stay current for all of
them — they are account-wide, and an idle session refreshes them every ten seconds.
With no terminal session at all the panel keeps the last reading and tells you how
old it is. See [Real usage limits](#real-usage-limits-recommended).

## 📊 Status Bar & Tooltip

The extension starts monitoring when VS Code opens. What the bar shows depends on
whether it can read your real limits:

```
Reset: 02:13:20 | 5h: 6% | 7d: 35% | C: $31.34      real limits enabled
Reset: 02:13:20 | C: $31.34 | T: 139.9k | M: 70     measured values only
```

**Status Bar Components:**
- **Reset** — countdown to the session reset (HH:MM:SS)
- **5h** / **7d** — percentage of the real 5-hour and weekly limits used, when
  [enabled](#real-usage-limits-recommended)
- **C** — session cost, with `/budget` and a percentage if you set one
- **T** — tokens used (input + output), as a percentage if you set a budget
- **M** — messages, as a percentage if you set a budget

`T` and `M` are omitted while the real limits are shown, to keep the bar short.

**Colour indicators** apply to whichever signal is most reliable — the real
limits first, otherwise your own budget:
- Neutral: below 60%
- Orange: 60-79%
- Red: 80% and above

**Hover over the status bar** for a tooltip with the usage limits, session timing,
cost (session and last 7 days), token breakdown including cache, and burn rates.

## 🎨 Detailed Popup & Advanced Analytics

Click the status bar to open the statistics panel.

**Session Timer** — countdown to the reset, with the window's start and end times.

**Usage Limits** — three tiles with the real percentage consumed of the context
window, the 5-hour window and the weekly window, each with its reset time, plus a
per-session context list. See [Real usage limits](#real-usage-limits-recommended).

**Token Usage, Cost Usage, Message Count** — each section shows one bar:
- a **progress bar** with a percentage, when you have set a budget for that metric
- otherwise a **composition bar** showing what the value is made of — tokens by
  model, cost by model, messages by project — with a legend underneath

The composition bar exists because there is no honest denominator to divide by
without a budget; it fills the same slot with real information instead of an
invented percentage.

**Advanced Analytics** — the "More..." toggles expand each section:
- **Token Components**: input, output, cache creation (split by 5-minute and
  1-hour writes) and cache read
- **Burn Rates**: tokens/min, $/min, messages/min
- **Usage by Project**: token distribution across your Claude projects
- **Usage by Model**: shown here when a token budget is set (otherwise it is
  already the composition bar above)

## Real usage limits (recommended)

Claude Code reports the **actual** percentage of your 5-hour and weekly limits you
have consumed, together with the exact reset timestamps. This is the only figure
that answers "how close am I to being cut off" — token and cost counts cannot,
because real consumption is weighted by model and effort level.

**To turn it on:** open the statistics popup (click the status bar) and press
**Turn on** in the *Usage Limits* section. The command palette equivalent is
`Claude: Enable Real Usage Limits`.

**What you get** — three tiles in the popup, plus `5h` and `7d` segments in the
status bar:

```
┌──────────────────┬──────────────────┬──────────────────┐
│     CONTEXT      │  5-HOUR WINDOW   │   7-DAY WINDOW   │
│       82%        │        6%        │       88%        │
│  PhotoManager    │  resets 14:35    │ resets Fri 20:01 │
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁    │ ▁▁               │ ▁▁▁▁▁▁▁▁▁▁▁▁▁    │
└──────────────────┴──────────────────┴──────────────────┘

CONTEXT PER SESSION (4)
PhotoManager          82% · just now
claude-statusbar      66% · 1 min ago
Apokryf-Galicyjski    91% · 16 min ago
eBooki                 — · 2 h ago
```

Numbers are green below 60%, amber to 80%, red above. A value Claude Code does not
report shows a dash — context is briefly absent right after `/compact`.

**Context is per session, the limits are per account.** The context window belongs
to one conversation, so with several Claude Code sessions open there is no single
"the" context: each is listed with its own percentage and how old that reading is
(a session that has been idle stops reporting). The Context tile cycles through the
open sessions every two seconds, naming the one it is showing, so the number never
changes owner without saying so. A `~` marks a percentage the extension worked out
from the transcript rather than one Claude Code reported. The 5-hour and weekly
figures need no such split — they are account-wide and identical in every session.

**How it works.** That data is only exposed in the JSON Claude Code pipes to a
status line command — no hook receives it, and it is not written to the transcript
files. So the extension installs a small status line script that mirrors the JSON
to a file and reads it from there.

- Works for Claude.ai Pro/Max subscribers (the data does not exist for API-key
  usage), and appears after the first response in a session.
- If you already use a status line, it keeps working — the bridge calls it with
  the same input and prints its output.
- `Claude: Disable Real Usage Limits` removes the script and restores your
  previous status line. `~/.claude/settings.json` is backed up before it is
  modified.
- `Claude: Show Usage Limits Bridge Status` reports what is installed and what the
  last reading contained.
- Requires `node` on your `PATH`.
- If Claude Code signs in with an **API key**, Amazon Bedrock or Google Cloud,
  there are no 5-hour or weekly windows at all — usage is billed per token. The
  section then says so and points you at the cost figures instead.
- **The Claude Code VS Code extension renders no status line**, so a session
  running there feeds the bridge nothing. Keep one terminal session open and the
  account-wide 5-hour and weekly numbers stay current for all of them — the setup
  sets `statusLine.refreshInterval`, so an idle terminal still refreshes them
  every ten seconds. With no terminal session at all the percentages stay at the
  last reading; the panel dates it and says so rather than passing a frozen number
  off as current. Everything measured from the transcripts — tokens, cost,
  messages, and each session's context — works the same either way.

Without the bridge the extension still works — you get accurate token and cost
figures, just no percentage of your plan.

## ⚙️ Configuration

### VS Code Settings

```json
{
  "claudeStatusBar.tokenBudget": 0,            // your token target; 0 = none
  "claudeStatusBar.costBudget": 0,             // your USD target;   0 = none
  "claudeStatusBar.messageBudget": 0,          // your message target; 0 = none
  "claudeStatusBar.refreshInterval": 5,        // 1-60 seconds
  "claudeStatusBar.showProjectName": false,    // project name in the panel header
  "claudeStatusBar.notifications.sessionEnded": true
}
```


### Budgets are opt-in

**No budgets are applied by default.** Tokens, cost, and messages are shown as
plain measured values, because Anthropic does not publish token or message quotas
and there is nothing honest to divide by: real consumption is weighted by model
and effort level, enforced over a 5-hour window plus weekly windows (Max plans
have two — all models, and Sonnet only), and the 5-hour limits were doubled in
May 2026. The real percentages come from the bridge above.

If you want a self-imposed pacing target, set one — the status bar then shows a
percentage and warning colours against *your* number, and the popup switches that
metric from a composition bar to a progress bar:

```json
{
  "claudeStatusBar.tokenBudget": 200000,
  "claudeStatusBar.costBudget": 40,
  "claudeStatusBar.messageBudget": 500
}
```

Or run `Claude: Set Budgets`, which asks for all three. `0` (or an empty answer)
means no budget for that metric.

> Upgrading from 0.4.x or earlier: `customTokenLimit`, `customCostLimit` and
> `customMessageLimit` are migrated to the names above automatically, and are still
> read if the migration never ran. The `claudeStatusBar.plan` setting was removed —
> plan presets carried token limits Anthropic never published.

## Installation

### Via VS Code Extension Manager

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for "Claude Code Status Bar Monitor"
4. Click **Install**

Or visit the [VS Code Marketplace page](https://marketplace.visualstudio.com/items?itemName=bartosz-warzocha.claude-statusbar)

### Manual Installation

```bash
npm install
npx @vscode/vsce package          # runs the production build, emits the .vsix
code --install-extension claude-statusbar-*.vsix
```

## Usage & Commands

Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- `Claude: Show Usage Details` - Open detailed metrics popup
- `Claude: Enable Real Usage Limits` - Read the actual 5-hour / weekly usage from Claude Code
- `Claude: Disable Real Usage Limits` - Remove the bridge, restore your status line
- `Claude: Show Usage Limits Bridge Status` - Diagnose the bridge in the output channel
- `Claude: Set Budgets` - Set your token, cost and message targets
- `Claude: Refresh Usage Stats` - Force refresh metrics

## How It Works

### Data Source

Claude Code stores conversation data locally in JSONL files:

- **Windows**: `%USERPROFILE%\.claude\projects\`
- **macOS/Linux**: `~/.claude/projects/` or `~/.config/claude/projects/`

The extension monitors these files for changes and calculates metrics in real-time.
Every entrypoint writes them identically, so a session started with `claude` in a
terminal and one started from the Claude Code VS Code extension are measured the
same way. Which sessions are currently open is read from Claude Code's own register
in `~/.claude/sessions/`, with the process checked, so a session that has ended
drops off the list instead of lingering.

### Session Windows

Claude Code uses **5-hour rolling sessions**, plus weekly windows. The extension:

1. Detects your first message timestamp
2. Calculates session expiry (5 hours later) — or, with the bridge enabled, uses
   the exact reset timestamp reported by Claude Code, as long as that timestamp is
   still in the future. Claude Code only refreshes it while it is running, so an
   expired one falls back to the locally computed window rather than declaring the
   session over
3. Tracks usage within the active window
4. Automatically resets when the session expires

Session windows are tracked on a rolling basis and are **not** cut at midnight, so
a window that starts at 22:00 keeps its full history past the date boundary.

Only files modified within the last week are read, and parsed results are cached by
modification time, so a large history does not cost CPU on every refresh.

### Token Calculation

**What counts toward limits:**

- ✅ `input_tokens` - Your prompts
- ✅ `output_tokens` - Claude's responses

**What doesn't count toward token limits:**

- ❌ `cache_creation_input_tokens` - Cache overhead
- ❌ `cache_read_input_tokens` - Cache hits

**Note:** Cache tokens ARE included in cost calculations but NOT in token limits.

### Cost Calculation

Costs use per-model published pricing (USD per million tokens), verified against
[Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
on 2026-07-26. Note that pricing is per **model version**, not per family — Opus
4.5+ costs a third of what Opus 4.1 did:

| Model | Input | Output | Cache write 5m | Cache write 1h | Cache read |
|-------|-------|--------|----------------|----------------|------------|
| **Fable 5 / Mythos 5** | $10.00 | $50.00 | $12.50 | $20.00 | $1.00 |
| **Opus 5 / 4.8 / 4.7 / 4.6 / 4.5** | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |
| **Opus 4.1 and earlier** | $15.00 | $75.00 | $18.75 | $30.00 | $1.50 |
| **Sonnet 5** (to 2026‑08‑31) | $2.00 | $10.00 | $2.50 | $4.00 | $0.20 |
| **Sonnet 5** (from 2026‑09‑01) / 4.6 / 4.5 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| **Haiku 4.5** | $1.00 | $5.00 | $1.25 | $2.00 | $0.10 |

Cache rates are fixed multipliers of the base input price: 1.25x for a 5-minute
cache write, **2x for a 1-hour write**, and 0.1x for a cache read. Claude Code
writes 1-hour cache entries almost exclusively, so treating them as 5-minute
writes understates cache cost by 37.5%.

Also accounted for:

- `speed: "fast"` — fast mode reprices Opus 5 / Opus 4.8 at $10/$50
- `inference_geo: "us"` — US-only inference applies a 1.1x multiplier
- Web search — $10 per 1,000 requests
- Model ids not in the table fall back to their family's rates and log a warning,
  so a newly released model is approximated rather than mispriced as Sonnet

## Privacy

All data processing happens **locally on your machine**:

- ✅ No data sent to external servers
- ✅ No telemetry or analytics
- ✅ No account required
- ✅ Reads only your local Claude files

## Requirements

- **VS Code**: 1.104.0 or higher
- **Claude Code**: an active installation with local conversation data, run from a
  terminal, from the Claude Code VS Code extension, or both
- **Node.js on `PATH`**: required only for the real usage limits — Claude Code runs
  the bridge script with it. Everything else works without it.
- **Claude.ai Pro or Max**: required for the 5-hour and weekly figures. They do not
  exist for API-key, Amazon Bedrock or Google Cloud sign-ins, where usage is billed
  per token and the cost figures are the relevant ones.

## Development

### Building

```bash
npm install
npm run compile
```

### Watch Mode

```bash
npm run watch
```

### Packaging

```bash
npm run package
vsce package
```

### Testing

```bash
npm run test
```

## Credits & Inspiration

This project was inspired by and built upon the excellent work of:

### GUI & Architecture

- **[yahyashareef48/claude-usage-monitor](https://github.com/yahyashareef48/claude-usage-monitor)** - Visual design and VS Code extension architecture
  - Status bar layout and styling
  - Webview panel implementation
  - Real-time file watching approach

### Calculation Logic & Accuracy

- **[Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)** - Precise usage calculations
  - Token counting methodology (excluding cache tokens from limits)
  - Cost calculation formulas with model-specific pricing
  - 5-hour rolling session window logic
  - P90-based custom plan analysis

**Note:** This extension combines the best of both projects - accurate calculations from Maciek's monitor with the polished GUI from Yahya's extension.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

For issues or feature requests, please visit the [GitHub repository](https://github.com/bartoszwarzocha/claude_statusbar).

---

**Enjoy monitoring your Claude Code usage!** 🚀
