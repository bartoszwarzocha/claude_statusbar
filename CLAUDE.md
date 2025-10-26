# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A VS Code extension that displays Claude Code usage statistics in the status bar. The extension monitors token consumption, costs, message counts, and session timers in real-time.

**Key Requirements:**
- Display format: `Reset: 00:00:00 | C: 12.56$/35.00$ | T: 65489/88000 | M: 255/450`
  - Reset: Countdown timer to session reset
  - C: Current cost vs limit
  - T: Token usage vs limit
  - M: Message count vs limit
- Hover popup: Detailed progress bars with percentages, per-minute consumption rates for tokens and costs
- Configuration: Two parameters only - 1) Claude Code plan, 2) refresh frequency

**Architecture Inspiration:**
- GUI design: Based on [claude-usage-monitor](https://github.com/yahyashareef48/claude-usage-monitor) (local: `/mnt/e/AI/claude-usage-monitor/`)
- Calculation logic: Based on [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)
- **Critical:** Use accurate calculations from Claude Code Usage Monitor, NOT the GUI reference which calculates incorrectly

## Development Commands

```bash
# Install dependencies
npm install

# Development build with type checking and linting
npm run compile

# Watch mode for development (runs both esbuild and tsc watchers in parallel)
npm run watch

# Production build
npm run package

# Type checking only
npm run check-types

# Linting only
npm run lint

# Run tests
npm test
```

## Core Architecture

### Data Flow

1. **Data Source**: Claude Code stores conversation data in JSONL files
   - Windows: `%USERPROFILE%\.claude\projects\`
   - macOS/Linux: `~/.claude/projects/` or `~/.config/claude/projects/`
   - Environment variable: `CLAUDE_CONFIG_DIR`

2. **File Structure**: Each project directory contains session files (`.jsonl`)
   - Each line is a JSON object with message data
   - Messages contain `usage` object with token counts
   - Files use format: `{message: {...}, timestamp: "...", type: "..."}`

3. **Session Calculation Logic**:
   - **5-hour rolling windows**: Session starts from first message, expires 5 hours later
   - Groups messages chronologically into 5-hour sets
   - Only counts tokens within active session window
   - Filters to today's messages only

4. **Token Counting Rules** (CRITICAL - matches Claude Code's limits):
   - ✅ Counts: `input_tokens` + `output_tokens`
   - ❌ Excludes: `cache_creation_input_tokens` and `cache_read_input_tokens`
   - See `sessionParser.ts:calculateTokensFromUsage()` for reference

### Key Components

**sessionParser.ts** - Parse JSONL files
- `parseSessionFile()`: Read and parse Claude session files line-by-line
- `calculateTokensFromUsage()`: Sum input + output tokens (excludes cache)
- `extractSessionId()`: Extract session ID from filename

**sessionCalculator.ts** - Calculate metrics
- `calculateSessionMetrics()`: Main calculation function
  - Deduplicates messages by ID across all files
  - Groups into 5-hour sets starting from first message
  - Finds active set overlapping with current time
  - Calculates total tokens, burn rate, time remaining
- `groupIntoFiveHourSets()`: Split messages into 5-hour windows
- `calculateBurnRate()`: Tokens/minute over last 10 minutes
- `formatTimeRemaining()`: Convert ms to "Xh Ym" format
- `getStatusColor()`: Green <60%, Yellow 60-80%, Red >80%

**statusBar.ts** - Status bar UI
- `StatusBarManager`: Manages VS Code status bar item
- `update()`: Refresh display with current metrics
- Color-coded backgrounds for warning/error states
- Click command to open popup

**extension.ts** - Main entry point
- `activate()`: Initialize extension
  - Find Claude data directories
  - Set up polling (default 5 seconds)
  - Register commands for plan selection
  - Aggregate all messages from all projects/files
- `updateMetrics()`: Periodic refresh function
- `getClaudeDataPaths()`: Locate Claude data directories

**types.ts** - TypeScript interfaces
- `MessageUsage`: Token counts from single message
- `ClaudeMessage`: Parsed message with timestamp, role, usage
- `SessionMetrics`: Calculated session data (tokens, timing, burn rate)
- `PlanConfig`: Plan type and token limit

### Plan Limits

| Plan | Token Limit | Cost Limit | Message Limit |
|------|-------------|------------|---------------|
| Pro | 19,000 | $18.00 | 250 |
| Max5 | 88,000 | $35.00 | 1,000 |
| Max20 | 220,000 | $140.00 | 2,000 |
| Custom | 44,000 (default) | $50.00 | 250 |

**Custom Plan Notes:**
- Default limits shown above
- User can configure custom token limit only
- Cost and message limits remain at default values

### Model Pricing (per million tokens)

| Model | Input | Output | Cache Creation | Cache Read |
|-------|-------|--------|----------------|------------|
| Opus | $15.00 | $75.00 | $18.75 | $1.50 |
| Sonnet | $3.00 | $15.00 | $3.75 | $0.30 |
| Haiku | $0.25 | $1.25 | $0.30 | $0.03 |

**Supported Models:**
- Opus: `claude-3-opus`, `claude-opus-4-20250514`
- Sonnet: `claude-3-sonnet`, `claude-3-5-sonnet`, `claude-sonnet-4-20250514`, `claude-sonnet-4-5-20250929`
- Haiku: `claude-3-haiku`, `claude-3-5-haiku`

### Cost Calculation Formula

```
Total Cost = (input_tokens / 1,000,000 × input_rate) +
             (output_tokens / 1,000,000 × output_rate) +
             (cache_creation_tokens / 1,000,000 × cache_creation_rate) +
             (cache_read_tokens / 1,000,000 × cache_read_rate)
```

**Important:** Unlike token limits, cache tokens ARE counted in cost calculations.

### Build System

**esbuild** - Used for bundling (see esbuild.js)
- Bundles TypeScript to single `dist/extension.js`
- Minifies in production mode
- External dependency: `vscode`

**npm-run-all** - Parallel script execution
- `watch` script runs esbuild and tsc watchers simultaneously
- Provides better development experience

### Extension Activation

- Activation event: `onStartupFinished`
- Main entry: `dist/extension.js`
- Custom icon font: `resources/Glyphter.woff` (character: `\005E`)

### File Watching

Uses `chokidar` for monitoring JSONL file changes:
- More reliable than Node.js fs.watch
- Cross-platform compatibility
- Detects file modifications in real-time

## Critical Implementation Notes

1. **Duplicate Message Handling**: Messages can appear in multiple files - must deduplicate by ID
2. **Session Window Logic**: Start timer from FIRST message of the day, not just any message
3. **Token Calculation**: Never count cache tokens toward limits - this is the most common error
4. **Multi-Project Support**: Extension must scan ALL projects in Claude data directory
5. **Time Filtering**: Only consider messages from current day (since midnight)
6. **Burn Rate Window**: Calculate over last 10 minutes for accurate predictions

## Data Path Priority

1. `CLAUDE_CONFIG_DIR` environment variable
2. `~/.config/claude/projects` (Linux/macOS)
3. `~/.claude/projects` (fallback)
4. User-configured override paths

## Expected Status Bar Format

```
Reset: 3h 45m | C: 12.56$/35.00$ | T: 65489/88000 | M: 255/450
```

Hover popup should show:
- Progress bars for tokens, cost, messages
- Percentage values
- Per-minute consumption rates (tokens/min, $/min)
- Session start and end times
