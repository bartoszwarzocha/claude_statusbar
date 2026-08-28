# Changelog

All notable changes to the Claude Code Status Bar Monitor extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.1] - 2026-08-28

Sessions running in the Claude Code **VS Code extension** were invisible to this
extension's Usage Limits section, and the Context tile flickered between sessions.

### Fixed
- **Sessions started from the Claude Code VS Code extension are now listed.** The
  bridge only ever sees sessions that render a status line, and the VS Code
  extension renders none - so a session working there never appeared, and the
  5-hour / weekly percentages silently froze at whatever a terminal session had
  last reported. Sessions are now discovered from the transcripts, which every
  entrypoint writes, and the bridge refines the ones it can see.
- **The Context tile no longer jumps between sessions.** It showed whichever
  session had reported most recently, so with two sessions open the number changed
  owner every few seconds. It now cycles through the open sessions every two
  seconds and names the one on screen.
- **Closed sessions are no longer listed as open.** The list was driven by a
  timeout - anything that had written recently enough. It now follows Claude
  Code's own register of running sessions (`~/.claude/sessions/`), and checks the
  process is alive so a crashed session's leftover file does not count. The
  timeout survives only as a fallback for Claude Code versions predating that
  register.
- **The rate limits no longer freeze between messages.** The bridge is a status
  line command, and Claude Code ran it only when a session redrew: idle terminal,
  no update. Installing it now also sets `statusLine.refreshInterval`, so any open
  terminal session refreshes the account-wide numbers every ten seconds. Existing
  installations are backfilled on startup. Measured before: one write per redraw.
  After: one every ten seconds, on the dot.
- **The panel no longer queues refresh passes behind each other.** Every
  transcript write triggered a full pass, a single reply produces many writes, and
  nothing stopped two passes overlapping. Bursts are now collapsed into one pass
  and passes cannot overlap - which is what made the panel feel slow under load,
  rather than any single pass being slow.
- The Usage Limits section is rendered whenever any session's context is known,
  not only when the bridge is feeding the 5-hour and weekly windows.

### Added
- **Context usage is estimated from the transcript** when Claude Code has not
  reported it - the tokens resident at the last reply, over the window size Claude
  Code last named. Measured against real sessions it lands within half a
  percentage point. Estimates are marked with `~` so they are never confused with
  Claude Code's own figures.
- **Stale rate limits are dated instead of shown as current.** Past half an hour
  the panel says how old the reading is, and names the VS Code extension as the
  reason when a session is running there. The status bar tooltip carries the same
  "as of" note.

---

## [0.5.0] - 2026-08-03

Context usage is now reported per Claude Code session, and the configuration has
been audited: after 0.4.x removed the fabricated plan limits, the `plan` setting and
its commands no longer affected anything, so everything that had lost its purpose is
gone and the remaining settings are named for what they actually are. Several panel
refresh bugs introduced in 0.4.x are fixed.

### Added
- **Context usage listed per Claude Code session.** The context window belongs to
  one conversation, not to the account, so with several sessions open a single
  figure was misleading - it showed whichever session had rendered its status line
  last. The bridge now records one file per session, and the panel lists every
  recent session with its own context percentage and how old that reading is. The
  Context tile names the session it refers to instead of being anonymous. The 5-hour
  and weekly figures are unaffected: those are account-wide and identical in every
  session.
- The installed bridge script is refreshed in place when it predates the current
  extension, so per-session data starts flowing without re-running the setup.

### Changed
- **Settings renamed** to match what they are - targets you choose, not limits:
  `customTokenLimit` → `tokenBudget`, `customCostLimit` → `costBudget`,
  `customMessageLimit` → `messageBudget`. Defaults are now `0` (no budget).
- `Claude: Set Plan to Custom` → **`Claude: Set Budgets`**, which asks for all three
  in one flow; an empty answer clears that budget.

### Removed
- **`claudeStatusBar.plan`.** With presets carrying no budgets and no longer gating
  the Usage Limits section, it only printed a label. The "Plan" tile in the popup is
  replaced by "Last 7 days" cost.
- Commands `Set Plan to Pro` / `Max5` / `Max20` from the palette - they changed
  nothing but that label. **The command IDs remain registered**, so an existing
  keybinding does not fail with "command not found": it explains the change and
  offers to set budgets or enable the real limits.
- Dead code: `LEGACY_PLAN_BUDGETS`, `PLAN_LIMITS`, `formatTokenCount`, and the
  `lastRateLimits` variable, which was written twice and never read.

### Fixed
- **"No Active Session" appeared after a period of inactivity, while the session
  was still running.** The countdown used the reset timestamp reported by Claude
  Code, but that value is only refreshed when Claude Code renders its status line -
  which it does per interaction. Sit idle past the reported reset and the snapshot
  still carries the old timestamp, so the extension concluded the window had closed
  even though the local window was open and messages were minutes old. The reported
  reset is now used only while it is still in the future; otherwise the locally
  computed window end applies. A session that has genuinely ended is still detected,
  because both sources have to agree before the session is dropped.
- **The panel stopped refreshing and had to be closed and reopened to show
  values.** `updateValue()` was deleted from the page script while the usage tiles
  were being added, so every live update threw `updateValue is not defined` part
  way through - leaving the panel on whatever it was showing, most visibly stuck on
  "No Active Session" after a session reset. The function is restored.
- The panel now reveals its content *before* recalculating, so a failure while
  updating a value can leave figures briefly stale but can no longer hide the whole
  panel until it is reopened.
- **Adjacent composition-bar segments could be exactly the same colour.** Colours
  came from the model family, so Opus 5 next to Opus 4.8 rendered as one
  indistinguishable block. Each family now has four shades and consecutive models
  take the next one. Project colours are nudged apart when two names hash to nearly
  the same hue, and the "Usage by Project" chart uses the same palette so a project
  looks identical everywhere in the panel.

### Compatibility
- Budgets written by an earlier version are migrated to the new keys on first run.
  The old keys are also still **read as a fallback**, so a configuration that never
  went through the migration (synced settings, fresh machine, manual edit) keeps
  working. Old values are never deleted, and the migration never overwrites a value
  already set under the new key.
- The retired plan presets are deliberately **not** converted into budgets: they were
  never real quotas, and restoring them would bring back percentages like "525%".

---

---

## [0.4.1] - 2026-07-28

GUI follow-up to 0.4.0: removing the fabricated token limit left progress bars with
nothing to fill, which looked broken.

### Fixed
- **Progress bars with no target rendered as an empty track with a dash beside it.**
  The bar is now hidden and its vertical margin collapses with it, so a section
  header no longer floats above its content.
- **The Usage Limits bars never appeared in an already-open statistics panel.**
  Pressing **Turn on** installed the bridge correctly and the status bar picked the
  data up, but the panel kept showing the placeholder: it refreshes through
  `postMessage`, and the bar elements were not in the DOM to update. The panel now
  re-renders when the section changes shape - bridge starts or stops reporting, a
  budget appears or disappears, the setting is toggled, or the plan changes - and
  keeps using `postMessage` for plain value updates so there is no flicker.

### Added
- **Usage Limits shown as three tiles** - Context, 5-hour window, 7-day window -
  each with a large threshold-coloured percentage, the reset time, and a thin bar.
  Context usage comes from the same bridge snapshot and was previously unused. A
  value Claude Code does not report (context is absent right after `/compact`)
  shows a dash and keeps its tile, so the three-column grid never collapses.
- **Composition bars.** A metric with no budget now shows what its value is made of
  instead of an empty slot: tokens by model, cost by model, messages by project,
  each with a legend. Same slot and height as a progress bar, so sections look
  consistent either way. When a budget is set, the progress bar is shown as before.
- Per-project message counts, which the Message Count composition bar needs.
- A third state for the Usage Limits section, for logins that have no such
  windows. When the bridge runs but Claude Code reports nothing - an API key,
  Amazon Bedrock or Google Cloud sign-in - the section says so and points at the
  cost figures, instead of leaving a "Turn on" button that would change nothing.
- A **Turn on** button in the Usage Limits section, replacing a wall of text that
  never said where to click. It runs the setup straight from the panel.

### Changed
- The Usage Limits section is always visible, on every plan, and states that it
  needs a Pro or Max subscription. It is the only authoritative source of "how much
  of my plan is left", so there is no setting to hide it any more.
- "Usage by Model" moved out of the collapsed details when it is already the
  composition bar above, to avoid showing the same chart twice.
- Tooltip section renamed back to "Session Timer" to match 0.3.0.
- README: removed the screenshots (they predate the GUI rework) and rewrote the
  status bar and popup descriptions to match what the extension actually renders.

---

## [0.4.0] - 2026-07-27

Correctness release. Model pricing and the whole notion of a "token limit" had
drifted badly out of date; cost was being overstated by roughly 2-3x.

### Added
- **Real usage limits from Claude Code** (`Claude: Enable Real Usage Limits`).
  Claude Code exposes the actual 5-hour and 7-day usage percentages and their
  reset timestamps in the JSON it pipes to a status line command - the only place
  they are available (no hook receives them, and they are absent from transcript
  files). The extension can now install a small status line script that mirrors
  that JSON to a file, and reads the real numbers from it.
  - Any status line you already use keeps working: the bridge calls it with the
    same stdin and prints its output.
  - `Claude: Disable Real Usage Limits` removes the script and restores your
    previous status line. `settings.json` is backed up before it is touched.
  - `Claude: Show Usage Limits Bridge Status` reports what is installed and what
    the last snapshot contained.
  - With the bridge active, the session countdown uses the API-provided reset
    timestamp instead of the local start+5h estimate.
- 7-day windows in the status bar, tooltip, and popup.
- Rolling 7-day token and cost totals.
- Per-model cost breakdown in the debug output.
- `claudeStatusBar.customCostLimit` and `claudeStatusBar.customMessageLimit`, so
  all three budgets are configurable (not just tokens). `0` disables a budget.

### Fixed
- **Model pricing was up to 3x wrong.** Prices are now per concrete model rather
  than per "opus/sonnet/haiku" keyword, which had collapsed models with a 3x
  price difference into one rate:
  - Opus 4.5 and later are $5/$25 per MTok, not $15/$75. Only Opus 4.1 and
    earlier are $15/$75.
  - Haiku 4.5 is $1/$5, not $0.25/$1.25 (4x understated).
  - Claude Fable 5 / Mythos 5 ($10/$50) were unrecognised and silently billed at
    Sonnet rates.
  - Sonnet 5 uses its $2/$10 introductory rate through 2026-08-31, then $3/$15.
  - Unknown future model ids now fall back to their family's rates and log once,
    instead of being silently priced as Sonnet.
- **1-hour cache writes were billed as 5-minute writes.** Claude Code writes
  1-hour cache entries almost exclusively, and those cost 2x base input, not
  1.25x. The per-TTL split from `usage.cache_creation` is now used.
- **Fast mode, US-only inference, and web search were not billed at all.**
  `speed: "fast"` reprices Opus 5 / Opus 4.8 at $10/$50, `inference_geo: "us"`
  applies a 1.1x multiplier, and web search costs $10 per 1,000 requests.
- **A session window that crossed midnight lost its first hours.** Messages were
  filtered to "since local midnight", so a window started at 22:00 was truncated
  at 00:00. History is now a rolling window, independent of the date boundary.
- `<synthetic>` messages written by Claude Code are no longer priced as Sonnet.

### Changed
- **Preset plans no longer impose token/cost/message budgets.** The hard-coded
  figures were not quotas — Anthropic does not publish any, real consumption is
  weighted by model and effort level, and the 5-hour limits were doubled in May
  2026. Dividing by them produced nonsense: a routine Max5 session measures
  ~460,000 tokens in one 5-hour window against the old 88,000 figure, i.e. "525%"
  and a permanently red status bar, while nothing was actually blocked. Tokens,
  cost, and messages are now reported as measured values. Real percentages come
  from the bridge; self-imposed budgets remain available via the three
  `custom*Limit` settings and apply to any plan.
- Status bar shows `5h` and `7d` percentages when real data is available, and
  falls back to token/message counters when it is not.
- A metric with no budget configured shows its raw value instead of a
  percentage against an invented limit.
- Popup gained a "Usage Limits" section, and the model breakdown chart now
  includes Fable and an "Other" bucket.

### Performance
- Session files are cached by mtime+size and files untouched for over a week are
  skipped without being opened. Previously every file in every project was
  re-parsed on each tick: measured at 615 ms per pass over a 101 MB / 46-file
  corpus, every 5 seconds. Only files that actually changed are now re-read.

---

## [0.2.2] - 2025-10-27

### Added
- **Session reset notifications**: Configurable notifications when session timer reaches zero
  - Notification #1: "Claude session ended" appears immediately when timer hits 0:00:00
  - Notification #2: "No new session detected" appears after 30 seconds if no activity detected
  - Both notifications configurable via VS Code settings
  - Settings:
    - `claudeStatusBar.notifications.sessionEnded` (default: true)
    - `claudeStatusBar.notifications.noNewSessionWarning` (default: true)
- **Refreshing state**: Status bar and popup now show "Refreshing..." state during session reset checks
- **30-second timeout logic**: Smart detection waits up to 30 seconds before showing "no session" warning
  - Allows time for Claude Code to write new messages to disk
  - Immediately shows stats if new session detected within timeout period
- **Development roadmap**: Added ROADMAP.md with detailed feature planning through v1.0.0

### Changed
- **Improved no-session message clarity**:
  - Changed from: "No Claude Code session found for today"
  - Changed to: "No active Claude Code session detected"
  - Removed misleading "for today" language (sessions reset every 5 hours, not daily)
  - Added actionable guidance: "Start a conversation with Claude to activate a new tracking session"

### Fixed
- Session reset detection now properly tracks state across multiple refresh cycles
- Background refresh continues checking for new sessions every 5 seconds during "Refreshing" state

---

## [0.2.1] - 2025-10-26

### Changed
- **Message filtering**: Now filters to today's messages only instead of last 8 days
  - Improves accuracy of daily session tracking
  - Reduces processing overhead for large conversation histories

---

## [0.2.0] - 2025-10-26

### Added
- **Enhanced popup UI**: Major visual improvements with detailed metrics visualization
  - Session timer with countdown display
  - Progress bars for tokens, cost, and messages with percentage indicators
  - Burn rate metrics (tokens/min, cost/min, messages/min)
  - Token breakdown section with detailed component view
  - Model usage breakdown (Opus, Sonnet, Haiku) with pie chart
  - Project breakdown showing token distribution across Claude projects
  - "More..." expandable sections for advanced analytics
  - Responsive design with smooth animations

### Changed
- **Calculation refactor**: Major improvements to session metrics calculation
  - More accurate 5-hour rolling window logic
  - Improved deduplication of messages across files
  - Better handling of session boundaries
  - Enhanced burn rate calculations over last 10 minutes

### Fixed
- Session end time calculation now properly accounts for rounded start times
- Cost calculations include all token types (input, output, cache creation, cache read)

---

## [0.1.0] - 2025-10-26

### Added
- **Initial release**: Core functionality for Claude Code usage monitoring
- **Status bar display**: Compact real-time monitoring in VS Code status bar
  - Format: `Reset: HH:MM:SS | C: X.X% | T: X.X% | M: X.X%`
  - Live countdown timer (updates every second)
  - Color-coded warnings:
    - Neutral: < 75% token usage
    - Orange: 75-89% token usage
    - Red: ≥ 90% token usage
- **Tooltip**: Quick overview on status bar hover
  - Session timing (start/end)
  - Token, cost, and message usage
  - Burn rates (tokens/min, cost/min, messages/min)
- **Detailed popup panel**: Click status bar to view comprehensive metrics
  - Session timing information
  - Token usage with progress bars
  - Cost tracking with model-specific pricing
  - Message count tracking
- **Plan configuration**: Support for multiple Claude Code subscription plans
  - Pro: 19,000 tokens, $18.00, 250 messages
  - Max5: 88,000 tokens, $35.00, 1,000 messages
  - Max20: 220,000 tokens, $140.00, 2,000 messages
  - Custom: User-defined token limit
- **Commands**: VS Code command palette integration
  - `Claude: Show Usage Details` - Open detailed metrics popup
  - `Claude: Set Plan to Pro/Max5/Max20/Custom` - Switch plans
  - `Claude: Refresh Usage Stats` - Force refresh
- **Configuration settings**:
  - `claudeStatusBar.plan` - Select subscription plan
  - `claudeStatusBar.customTokenLimit` - Set custom token limit
  - `claudeStatusBar.refreshInterval` - Metrics refresh frequency (1-60 seconds)
- **Real-time file watching**: Monitors Claude data files for changes using chokidar
- **Multi-project support**: Aggregates usage across all Claude Code projects
- **Session metrics**:
  - 5-hour rolling session windows
  - Token counting (input + output, excludes cache from limits)
  - Cost calculation with model-specific pricing (Opus, Sonnet, Haiku)
  - Message count tracking
  - Burn rate calculations
  - Time remaining until session reset
- **Cross-platform support**: Works on Windows, macOS, and Linux
  - Automatic detection of Claude data directories
  - Environment variable support (`CLAUDE_CONFIG_DIR`)
- **Privacy**: All data processing happens locally
  - No external servers
  - No telemetry
  - Reads only local Claude conversation files

---

## Release Notes

### [0.2.2] - Session Reset Notifications
This release adds intelligent session reset notifications with a 30-second detection window. When your session timer reaches zero, the extension will notify you and check for new activity for up to 30 seconds before alerting you that no new session was detected. This prevents false positives when you're actively starting a new conversation.

### [0.2.1] - Daily Message Filtering
Improved accuracy by filtering to today's messages only, reducing processing overhead and focusing on current day usage.

### [0.2.0] - Enhanced UI & Calculations
Major visual overhaul with detailed analytics, improved session calculations, and comprehensive token/cost/project breakdowns.

### [0.1.0] - Initial Release
First public release with core monitoring features, real-time updates, and multi-plan support.

---

## Upcoming Features

See [ROADMAP.md](ROADMAP.md) for detailed feature planning through v1.0.0.

**Next release (v0.3.0)**: Smart Notifications
- Configurable threshold alerts (80%, 90%, 95%)
- Predictive warnings based on burn rate
- "Don't show again for this session" option

---

## Contributing

Found a bug or have a feature request? Please visit the [GitHub repository](https://github.com/bartoszwarzocha/claude_statusbar/issues).

---

**Note**: This extension is not officially affiliated with Anthropic or Claude AI. It's an independent tool for monitoring local Claude Code usage data.
