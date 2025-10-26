<div align="center">
  <img src="resources/icon.png" alt="Claude Status Bar Icon" width="128" height="128">
  <h1>Claude Code Status Bar Monitor</h1>
  <p>A VS Code extension that displays real-time Claude Code usage statistics directly in your status bar.</p>
</div>

## Features

### 📊 Status Bar Display
Compact, real-time monitoring in your status bar:
```
Reset: 03:45:12 | C: 12.56$/35.00$ | T: 65489/88000 | M: 255/1000
```

Where:
- **Reset**: Countdown timer to session reset (HH:MM:SS)
- **C**: Current cost vs limit
- **T**: Token usage vs limit
- **M**: Message count vs limit

### 🎨 Detailed Popup
Click the status bar to see detailed metrics with:
- Progress bars for tokens, cost, and messages
- Percentage indicators
- Per-minute consumption rates (tokens/min, $/min, messages/min)
- Session timing information
- Token breakdown (input, output, cache creation, cache read)

### ⚙️ Configuration
Simple configuration with just two settings:
1. **Plan**: Choose from Pro, Max5, Max20, or Custom
2. **Refresh Interval**: Update frequency (1-60 seconds)

## Installation

1. Install from VS Code Marketplace (coming soon)
2. Or install manually:
   ```bash
   npm install
   npm run package
   code --install-extension claude-statusbar-0.1.0.vsix
   ```

## Usage

### Status Bar
The extension automatically starts monitoring when you open VS Code. The status bar shows real-time usage with color-coded warnings:
- 🟢 Green: < 60% of limit
- 🟡 Yellow: 60-80% of limit
- 🔴 Red: > 80% of limit

### Commands
Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):
- `Claude: Show Usage Details` - Open detailed metrics popup
- `Claude: Set Plan to Pro` - Switch to Pro plan (19k tokens)
- `Claude: Set Plan to Max5` - Switch to Max5 plan (88k tokens)
- `Claude: Set Plan to Max20` - Switch to Max20 plan (220k tokens)
- `Claude: Set Plan to Custom` - Set custom token limit
- `Claude: Refresh Usage Stats` - Force refresh metrics

## Configuration

### VS Code Settings

```json
{
  "claudeStatusBar.plan": "max5",              // pro, max5, max20, or custom
  "claudeStatusBar.customTokenLimit": 44000,   // Only for custom plan
  "claudeStatusBar.refreshInterval": 5          // 1-60 seconds
}
```

### Plan Limits

| Plan | Token Limit | Cost Limit | Message Limit |
|------|-------------|------------|---------------|
| **Pro** | 19,000 | $18.00 | 250 |
| **Max5** | 88,000 | $35.00 | 1,000 |
| **Max20** | 220,000 | $140.00 | 2,000 |
| **Custom** | User-defined | $50.00 | 250 |

## How It Works

### Data Source
Claude Code stores conversation data locally in JSONL files:
- **Windows**: `%USERPROFILE%\.claude\projects\`
- **macOS/Linux**: `~/.claude/projects/` or `~/.config/claude/projects/`

The extension monitors these files for changes and calculates metrics in real-time.

### Session Windows
Claude Code uses **5-hour rolling sessions**. The extension:
1. Detects your first message timestamp
2. Calculates session expiry (5 hours later)
3. Tracks usage within the active window
4. Automatically resets when session expires

### Token Calculation
**What counts toward limits:**
- ✅ `input_tokens` - Your prompts
- ✅ `output_tokens` - Claude's responses

**What doesn't count toward token limits:**
- ❌ `cache_creation_input_tokens` - Cache overhead
- ❌ `cache_read_input_tokens` - Cache hits

**Note:** Cache tokens ARE included in cost calculations but NOT in token limits.

### Cost Calculation
Costs are calculated using model-specific pricing:

| Model | Input | Output | Cache Creation | Cache Read |
|-------|-------|--------|----------------|------------|
| **Opus** | $15.00/M | $75.00/M | $18.75/M | $1.50/M |
| **Sonnet** | $3.00/M | $15.00/M | $3.75/M | $0.30/M |
| **Haiku** | $0.25/M | $1.25/M | $0.30/M | $0.03/M |

*Pricing per million tokens*

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
