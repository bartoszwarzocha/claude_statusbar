<div align="center">
  <h1>Claude Code Status Bar Monitor</h1>
  <p>A VS Code extension that displays real-time Claude Code usage statistics directly in your status bar.</p>
</div>

## 📊 Status Bar & Tooltip

The extension automatically starts monitoring when you open VS Code. The status bar shows real-time usage with color-coded warnings based on token usage:

```
Reset: 03:45:12 | C: 35.9% | T: 74.4% | M: 25.5%
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

**Usage Limits** — two progress bars with the real percentage of the 5-hour and
weekly windows consumed and the exact reset times. See
[Real usage limits](#real-usage-limits-recommended).

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
│       53%        │        6%        │       88%        │
│ current session  │  resets 14:35    │ resets Fri 20:01 │
│ ▁▁▁▁▁▁▁▁         │ ▁▁               │ ▁▁▁▁▁▁▁▁▁▁▁▁▁    │
└──────────────────┴──────────────────┴──────────────────┘
```

Numbers are green below 60%, amber to 80%, red above. A value Claude Code does not
report shows a dash — context is briefly absent right after `/compact`.

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

### Session Windows

Claude Code uses **5-hour rolling sessions**, plus weekly windows. The extension:

1. Detects your first message timestamp
2. Calculates session expiry (5 hours later) — or, with the bridge enabled, uses
   the exact reset timestamp reported by Claude Code
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
- **Claude Code**: Active installation with local conversation data
- **Node.js**: Only for development

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
