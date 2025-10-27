# Changelog

All notable changes to the Claude Code Status Bar Monitor extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
