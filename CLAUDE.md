# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A VS Code extension that displays Claude Code usage in the status bar: real 5-hour and weekly limit
usage, cost, tokens, messages and a session countdown.

**Status bar format** depends on what data is available:

```
Reset: 02:13:20 | 5h: 6% | 7d: 35% | C: $31.34          bridge enabled
Reset: 02:13:20 | C: $31.34 | T: 139.9k | M: 70         bridge disabled, no budgets
```

`T` and `M` show a percentage instead of a raw value when the user sets a budget, and are omitted
entirely while the real limits are shown.

**Panel** (click the status bar): session countdown, a Usage Limits section, and one section each for
tokens, cost and messages, plus collapsible breakdowns.

## The two things most likely to be got wrong

**1. There is no such thing as a token limit.** Anthropic does not publish token or message quotas.
Real consumption is weighted by model and effort level, enforced over a 5-hour window plus weekly
windows (Max plans have two: all models, and Sonnet-only), and the 5-hour limits were doubled in May
2026. Earlier versions of this extension divided usage by a hard-coded 88,000 for Max5; a routine
session measures ~460,000 tokens in one window, so that produced "525%" and a permanently red status
bar while nothing was actually blocked.

Never reintroduce per-plan token/cost/message limits. Budgets are opt-in pacing targets the user sets.

**2. Authoritative usage comes from Claude Code, not from arithmetic.** The real percentages live in
`rateLimits.ts` - see below. Locally computed tokens and cost are accurate measurements, but they
cannot answer "how close am I to being cut off".

## Development Commands

```bash
npm install            # dependencies
npm run compile        # check-types + lint + build
npm run watch          # esbuild and tsc watchers in parallel
npm run package        # production build
npm run check-types    # tsc --noEmit
npm run lint           # eslint src
npx @vscode/vsce package   # emits the .vsix
```

## Core Architecture

### Data sources

There are **two**, and they answer different questions.

**1. Transcript files** - what was consumed.

- Windows: `%USERPROFILE%\.claude\projects\`, macOS/Linux: `~/.claude/projects/`
- Env override: `CLAUDE_CONFIG_DIR`
- One `.jsonl` per session; each line a JSON object; assistant lines carry `message.usage`

**2. The status line bridge** - how much of the plan is left.

Claude Code exposes `rate_limits.five_hour` / `.seven_day` (percentage used + reset timestamp) and
`context_window.used_percentage` **only** in the JSON it pipes to a status line command. No hook
receives them, and they are absent from the transcripts - both were checked, do not go looking again.
So `rateLimits.ts` installs a small status line script that mirrors that JSON to
`~/.claude/claude-statusbar-bridge.json`, which the extension reads and watches.

The data exists only for Claude.ai Pro/Max sign-ins. With an API key, Bedrock or Google Cloud the
field is simply absent - that is the `rateLimitsStatus: 'waiting'` state, not an error.

**The bridge cannot see the VS Code extension.** Claude Code's own VS Code extension
(`entrypoint: "claude-vscode"` in the transcripts) has no status line, so it never runs the script:
no snapshot, no per-session file. Working there leaves the 5-hour and weekly percentages frozen at
the last terminal reading until they age out. There is no second source - `claude` has no `usage`
subcommand, no OTEL metric carries rate limits, and nothing else under `~/.claude` holds them; this
was checked, do not go looking again. What the extension does instead is (a) date the reading rather
than let it pass for live, and (b) derive everything it can from the transcripts, which every
entrypoint writes identically.

**3. `~/.claude/sessions/<pid>.json` - which sessions are open.** Claude Code writes one file per
running process with `sessionId`, `cwd`, `entrypoint`, a derived `name` and `status`, and removes it
on exit. `liveSessions.ts` reads them and checks the PID with `process.kill(pid, 0)` (works on
Windows), because a crash leaves the file behind. This is the authority for the session list - a
timeout is wrong in one direction or the other, and both directions were reported as bugs.

**4. Transcripts again, for session discovery.** `sessionParser.ts:parseSessionFileWithMeta()`
returns `TranscriptMeta` alongside the messages - `sessionId`, `cwd`, `entrypoint`, the `ai-title`
line, and the tokens resident at the last non-sidechain reply. `sessionRegistry.ts` merges that with
the bridge's per-session files: transcripts decide which sessions exist, the bridge sharpens the ones
it can see. A bridge reading older than the transcript loses to the local estimate, which is what
happens when a CLI session is resumed inside the VS Code extension.

### Session windows

- 5-hour rolling windows, grouped from the first message, start truncated to the full hour
- A new window starts when a message falls past the previous end, or after a >= 5h gap
- **Do not filter to "since midnight".** A window starting at 22:00 legitimately spans the date
  boundary; the old midnight cutoff silently dropped its first hours. History is a rolling
  7-day + 5-hour window (weekly totals need the 7 days)
- With the bridge active, the countdown uses the API-provided `resets_at` rather than start + 5h

### Token counting for limits

Only `input_tokens + output_tokens`. Cache tokens are excluded from limit accounting but **are**
billed - see `sessionParser.ts:calculateLimitTokens()`.

### Key components

**pricing.ts** - per-model prices, not per-family
- `MODEL_PRICING`: keyed by model-id prefix, matched longest-first so `claude-opus-4-5-20251101`
  resolves before `claude-opus-4`
- `getModelPricing()`: handles Sonnet 5 introductory pricing (until 2026-08-31) and fast mode
- `splitCacheCreation()`: 5-minute vs 1-hour cache writes - **Claude Code writes 1-hour entries
  almost exclusively and they cost 2x base input, not 1.25x**
- `calculateMessageCost()`: all token categories + `inference_geo: "us"` 1.1x + web search

**rateLimits.ts** - the bridge
- `installBridge()` / `uninstallBridge()`: writes the status line script, backs up `settings.json`,
  preserves any pre-existing status line by delegating to it. Also sets `statusLine.refreshInterval`
  (Claude Code >= 2.1.97) - **without it the status line runs only when a session redraws, so the
  limits freeze on an idle terminal and never move at all while the work is in the VS Code
  extension**. `ensureStatusLineRefreshInterval()` backfills it into installs from 0.5.0
- `readRateLimits()`: parses the snapshot; returns undefined when stale (>12h) or without windows
- `getBridgeStatus()`: installed / wired into settings / delegate / snapshot age

**sessionParser.ts** - `parseSessionFile()`, `parseSessionFileWithMeta()` (same single pass, plus the
session facts), `extractUsage()` (cache split, speed, geo, server tools), `calculateLimitTokens()`

**liveSessions.ts** - `readLiveSessions()`: the PID-checked register of running sessions

**sessionRegistry.ts** - `buildSessionContexts()`: transcripts + bridge files + live sessions -> the
session list.
Context percent = resident tokens / window size, where the size comes from the bridge at any age
(it is a property of the plan, not a reading that goes stale). Estimates are flagged `estimated` and
render with a `~`.

**sessionCalculator.ts** - `calculateSessionMetrics()`: dedupe by `id:requestId`, group into 5-hour
sets, pick the set overlapping now, aggregate tokens/cost/model/project, burn rates over 10 minutes

**statusBar.ts** - status bar text and tooltip; colour comes from the real limits when available,
otherwise from a configured budget, otherwise nothing

**sessionPopup.ts** - the webview. Two rendering paths that must stay in sync:
- server-side TypeScript for the initial HTML
- mirrored JavaScript inside the page for live refreshes
- `layoutKey()` decides between a full re-render and `postMessage`. The Usage Limits section and the
  progress-vs-composition bar choice are baked into the markup, so a change there **must** re-render -
  `postMessage` cannot create elements that are not in the DOM. The stale-data warning and the VS Code
  caveat are markup too, so both are in the key
- The Context tile cycles through the open sessions every 2 s from a timer inside the page. The
  rotation index lives in the page, and `updateLimitTiles()` clamps rather than resets it, so a
  refresh does not knock the rotation back to the first session

**extension.ts** - activation, polling, file watching, commands, settings migration

### Pricing (USD per million tokens, verified 2026-07-26)

| Model | Input | Output | Cache 5m | Cache 1h | Cache read |
|---|---|---|---|---|---|
| Fable 5 / Mythos 5 | $10 | $50 | $12.50 | $20 | $1.00 |
| Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5 | $25 | $6.25 | $10 | $0.50 |
| Opus 4.1 and earlier | $15 | $75 | $18.75 | $30 | $1.50 |
| Sonnet 5 (to 2026-08-31) | $2 | $10 | $2.50 | $4 | $0.20 |
| Sonnet 5 (from 2026-09-01) / 4.6 / 4.5 | $3 | $15 | $3.75 | $6 | $0.30 |
| Haiku 4.5 | $1 | $5 | $1.25 | $2 | $0.10 |

Cache rates are fixed multipliers of base input: 1.25x (5m write), 2x (1h write), 0.1x (read).
Source: https://platform.claude.com/docs/en/about-claude/pricing

Fast mode reprices Opus 5 / 4.8 at $10/$50. Web search is $10 per 1,000 requests.

### Configuration

| Setting | Default | Purpose |
|---|---|---|
| `tokenBudget` | `0` | Optional token pacing target; `0` = none |
| `costBudget` | `0` | Optional USD target |
| `messageBudget` | `0` | Optional message target |
| `refreshInterval` | `5` | Poll seconds (1-60) |
| `notifications.sessionEnded` | `true` | Notify when the countdown hits zero |
| `showProjectName` | `false` | Project name in the panel header |

Removed in 0.5.0: `plan`, `customTokenLimit`, `customCostLimit`, `customMessageLimit`.
**The old budget keys are still read as a fallback and migrated on first run - keep it that way.**
The `setPlanPro` / `setPlanMax5` / `setPlanMax20` / `setPlanCustom` command IDs stay registered so
existing keybindings do not break; they explain the change instead of doing nothing.

### Build system

esbuild bundles to `dist/extension.js` (external: `vscode`); `npm-run-all` runs the watchers in
parallel. Activation: `onStartupFinished`. Custom icon font: `resources/Glyphter.woff` (`\005E`).
`chokidar` watches both the transcripts and the bridge snapshot.

## Implementation notes

1. **Deduplicate** messages by `id:requestId`, keeping the first occurrence - streaming writes repeat
2. **Scan every project** under the data directory, not just the current workspace
3. **Do not re-parse everything on every tick.** Files are cached by mtime+size and anything untouched
   for over a week is skipped unopened. A full pass measured 615 ms over 101 MB / 46 files, and it ran
   every 5 seconds. `extension.ts` also debounces file events into one pass and refuses to run two
   passes at once - one reply writes its transcript many times, and the bridge snapshot is rewritten
   every 10 s on top of that
4. **Never invent a denominator.** With no budget, show the measured value - the panel then renders a
   composition bar (what the value is made of) rather than an empty progress bar
5. **Colours**: each model family has four shades so two models of the same family sitting next to
   each other in a bar stay distinguishable; project colours are nudged apart on hash collisions
6. **Backwards compatibility is a requirement**, not a nicety: migrate renamed settings, keep reading
   the old keys, and keep retired command IDs registered

## Verifying changes

There is no test runner wired up for the webview. What has worked:

- Render the popup with a stubbed `vscode` module and assert against the produced HTML
- For live-refresh behaviour, extract the page `<script>` and execute it against a DOM stub - stub
  `setInterval`, or the countdown keeps the Node process alive
- Compare cost calculations against the real transcripts in `~/.claude/projects/`
