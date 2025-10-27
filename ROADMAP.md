# 🗺️ Claude Status Bar Monitor - Development Roadmap

**Current Version**: 0.2.1 (Published)
**Roadmap Start Date**: 2025-10-27
**Release Cycle**: Weekly (starting v0.2.2)
**Versioning**: Semantic Versioning (MAJOR.MINOR.PATCH)

---

## 🚨 IMMEDIATE PRIORITY

### v0.2.2 - Session Reset Notifications
**Release**: 2025-10-27/28 (Today/Tomorrow)
**Type**: PATCH
**Effort**: 🟢 Very Low (1-2 hours)
**Impact**: 🔥🔥🔥 Critical
**Status**: ⏳ Ready to implement

#### Features
- Notification when session timer reaches 0:00:00
- "🔄 Claude session has ended. Checking for new session..." message
- Post-refresh notifications:
  - ✅ "New Claude session started!" (if new messages found)
  - ℹ️ "Claude session ended. No new messages detected." (if no activity)
- Quick action buttons: "View Details" / "Dismiss"

#### Implementation Details
**Files to modify**:
- `src/extension.ts` - Add notification logic in timer callback and updateMetrics()
- `package.json` - Bump version to 0.2.2

**Code changes** (src/extension.ts):
```typescript
// Add wasRefreshing state tracking
let wasRefreshing = false;

// In timerInterval callback (line ~166):
if (timeRemaining === 0 && !isRefreshing) {
  isRefreshing = true;
  statusBar.showRefreshing();

  vscode.window.showInformationMessage(
    '🔄 Claude session has ended. Checking for new session...',
    'View Details'
  ).then(selection => {
    if (selection === 'View Details') {
      vscode.commands.executeCommand('claude-statusbar.showDetails');
    }
  });

  wasRefreshing = true;
  setTimeout(() => updateMetrics(), 100);
}

// In updateMetrics() - after finding new session (line ~109):
if (metrics && metrics.isActive) {
  if (wasRefreshing && !currentSession) {
    vscode.window.showInformationMessage('✅ New Claude session started!', 'View Details');
  }
  currentSession = metrics;
  isRefreshing = false;
  wasRefreshing = false;
}

// In updateMetrics() - no active session (line ~128):
else {
  if (wasRefreshing && currentSession) {
    vscode.window.showInformationMessage('ℹ️ Claude session ended. No new messages detected.');
  }
  currentSession = null;
  isRefreshing = false;
  wasRefreshing = false;
}
```

#### Testing Checklist
- [ ] Wait for session timer to reach 0:00:00
- [ ] Verify "session has ended" notification appears
- [ ] Verify appropriate notification after refresh (new session vs no activity)
- [ ] Manual refresh should NOT trigger notifications
- [ ] Test with messages and without messages

#### Deployment
1. Implement changes (~1 hour)
2. Local testing (~30 min)
3. Version bump: 0.2.1 → 0.2.2 in package.json
4. Build: `npm run package`
5. Package: `vsce package`
6. Publish: `vsce publish`
7. Git: `git commit -m "chore: Bump version to 0.2.2 - Add session reset notifications"`

---

## 📅 Weekly Release Timeline

### Week 1: v0.3.0 - Smart Notifications
**Release**: 2025-11-03
**Type**: Minor
**Effort**: 🟢 Low (1-2 days)
**Impact**: 🔥🔥🔥 High

**Features**:
- Configurable notification thresholds (80%, 90%, 95% token limit)
- Token limit exceeded notification
- Session reset notifications (from v0.2.2)
- Predictive warnings: "At current rate, tokens will run out in X minutes"
- "Don't show again for this session" option
- Quick action buttons in notifications

**New Settings**:
```json
{
  "claudeStatusBar.notifications.enabled": true,
  "claudeStatusBar.notifications.thresholds": [80, 90, 95],
  "claudeStatusBar.notifications.predictiveWarnings": true,
  "claudeStatusBar.notifications.resetAlert": true
}
```

**Files**:
- `src/notificationManager.ts` (new)
- `src/extension.ts` (modify)
- `package.json` (add settings)

---

### Week 2: v0.4.0 - Quick Actions & Shortcuts
**Release**: 2025-11-10
**Type**: Minor
**Effort**: 🟢 Low (1-2 days)
**Impact**: 🔥🔥 Medium-High

**Features**:
- Keyboard shortcuts:
  - `Ctrl+Shift+C` / `Cmd+Shift+C` - Toggle popup
  - `Ctrl+Shift+Alt+C` / `Cmd+Shift+Alt+C` - Force refresh
- Context menu on status bar (right-click):
  - Show Details
  - Change Plan (submenu)
  - Refresh Stats
  - Open Settings
- Middle-click to force refresh

**Files**:
- `package.json` (add keybindings)
- `src/extension.ts` (add menu support)
- `src/statusBar.ts` (context menu handling)

---

### Week 3: v0.5.0 - History Tracking & Export
**Release**: 2025-11-17
**Type**: Minor
**Effort**: 🟡 Medium (3-4 days)
**Impact**: 🔥🔥🔥 High

**Features**:
- Daily snapshots storage (`~/.claude-statusbar/history.json`)
- History viewer in popup (new tab)
- Statistics: daily average, peak usage day, weekly/monthly totals
- Export to CSV: "Claude: Export Usage History to CSV"
- Data filtering: Last 7/30 days

**Storage Format**:
```json
{
  "snapshots": [
    {
      "date": "2025-11-17",
      "tokens": 45000,
      "cost": 12.50,
      "messages": 120,
      "models": { "sonnet": 0.7, "haiku": 0.3 },
      "projects": { "project-a": 30000, "project-b": 15000 }
    }
  ]
}
```

**Files**:
- `src/historyManager.ts` (new)
- `src/historyViewer.ts` (new)
- `webview/history.html` (new)
- `src/sessionPopup.ts` (modify)

---

### Week 4: v0.6.0 - Visual Analytics
**Release**: 2025-11-24
**Type**: Minor
**Effort**: 🟡 Medium (3-4 days)
**Impact**: 🔥🔥 Medium

**Features**:
- Sparkline graphs (last 24h token usage)
- Enhanced interactive pie charts
- Trend indicators (↑↓) with color coding
- Hour-by-hour activity heatmap
- Responsive charts for different screen sizes

**Dependencies**:
- Lightweight charting library (recommend: Chart.js or custom SVG)

**Files**:
- `webview/charts.ts` (new)
- `src/chartRenderer.ts` (new)
- `webview/styles/charts.css` (new)
- `src/sessionPopup.ts` (modify)

---

### Week 5: v0.7.0 - Budget & Cost Management
**Release**: 2025-12-01
**Type**: Minor
**Effort**: 🟡 Medium (3 days)
**Impact**: 🔥🔥🔥 High

**Features**:
- Monthly budget setting and tracking
- Budget progress in status bar (optional)
- Cost projections: "At current rate, you'll spend $X this month"
- Month-over-month comparison
- Budget alerts at 80%, 90%, 100%
- Top 5 most expensive projects this month

**New Settings**:
```json
{
  "claudeStatusBar.monthlyBudget": null,
  "claudeStatusBar.showMonthlyBudgetInStatusBar": false,
  "claudeStatusBar.budgetAlerts": true
}
```

**Files**:
- `src/budgetManager.ts` (new)
- `src/extension.ts` (modify)
- `package.json` (add settings)

---

### Week 6: v0.8.0 - Advanced Metrics & Insights
**Release**: 2025-12-08
**Type**: Minor
**Effort**: 🟡 Medium-High (4-5 days)
**Impact**: 🔥🔥 Medium

**Features**:
- Efficiency metrics:
  - Average prompt length vs response length
  - Cache hit rate calculation
  - Cost per message
  - Tokens per minute (real-time)
- Model usage insights:
  - "You used Sonnet 80% of the time"
  - "Switching to Haiku for simple tasks could save $X"
- Optimization suggestions (rule-based)
- Comparison: this session vs average session

**New Section**: "Insights & Recommendations" in popup

**Files**:
- `src/metricsAnalyzer.ts` (new)
- `src/recommendationEngine.ts` (new)
- `src/sessionPopup.ts` (modify)

---

### Week 7: v0.9.0 - Settings UI & Onboarding
**Release**: 2025-12-15
**Type**: Minor
**Effort**: 🟡 Medium (3-4 days)
**Impact**: 🔥🔥 Medium

**Features**:
- Custom settings webview UI
- Onboarding wizard (first-run):
  - Select plan
  - Configure notifications
  - Set budget
- "What's New" popup after updates
- Contextual help tooltips throughout UI
- "Skip" option for advanced users

**Commands**:
- "Claude: Open Settings UI"
- "Claude: Run Onboarding Wizard"

**Files**:
- `src/settingsUI.ts` (new)
- `src/onboarding.ts` (new)
- `webview/settings.html` (new)
- `webview/onboarding.html` (new)
- `src/extension.ts` (modify)

---

### Week 8: v1.0.0 - Stable Release 🎉
**Release**: 2025-12-22
**Type**: Major
**Effort**: 🔴 High (full week)
**Impact**: 🔥🔥🔥 Critical

**Goals**:
- Code cleanup & refactoring
- Comprehensive testing (unit + integration)
- Performance optimizations:
  - Caching improvements
  - Lazy loading
  - Reduced file I/O
- Complete documentation:
  - API docs
  - Developer guide
  - Contribution guidelines
- Accessibility improvements (a11y)
- Internationalization prep (i18n structure)
- Security audit
- Bug fixes from 0.x versions

**Deliverables**:
- Production-ready release
- Comprehensive test suite
- Complete documentation
- CHANGELOG.md
- Contributing guide
- Development setup guide

---

## 🚀 Post-1.0 Roadmap (Future)

### v1.1.0 - Workspace Features
- Workspace-specific settings
- Project-specific configuration
- Team sharing foundation

### v1.2.0 - Cloud Sync (Optional)
- Multi-device history sync
- Cloud backup of settings
- Cross-machine notifications

### v1.3.0 - Team Edition (Enterprise)
- Shared token pools
- Team dashboard
- Usage comparison
- Team notifications

### v2.0.0 - Claude API Integration
- Fetch real limits from Claude API
- Real-time account sync
- Anomaly detection
- Automatic recommendations

---

## 📊 Version Overview

| Version | Date | Type | Effort | Impact | Primary Feature |
|---------|------|------|--------|--------|-----------------|
| **0.2.2** | 2025-10-27 | PATCH | 🟢 | 🔥🔥🔥 | Session reset notifications |
| **0.3.0** | 2025-11-03 | MINOR | 🟢 | 🔥🔥🔥 | Smart notifications |
| **0.4.0** | 2025-11-10 | MINOR | 🟢 | 🔥🔥 | Keyboard shortcuts |
| **0.5.0** | 2025-11-17 | MINOR | 🟡 | 🔥🔥🔥 | History & export |
| **0.6.0** | 2025-11-24 | MINOR | 🟡 | 🔥🔥 | Visual analytics |
| **0.7.0** | 2025-12-01 | MINOR | 🟡 | 🔥🔥🔥 | Budget management |
| **0.8.0** | 2025-12-08 | MINOR | 🟡 | 🔥🔥 | Advanced metrics |
| **0.9.0** | 2025-12-15 | MINOR | 🟡 | 🔥🔥 | Settings UI |
| **1.0.0** | 2025-12-22 | MAJOR | 🔴 | 🔥🔥🔥 | Stable release |

---

## 🎯 Features by Priority

### Tier 1: Must-Have (Implement First)
1. ✅ v0.2.2 - Session reset notifications
2. ✅ v0.3.0 - Smart token limit alerts
3. ✅ v0.5.0 - History tracking
4. ✅ v0.7.0 - Budget management

### Tier 2: Should-Have (High Value)
5. ✅ v0.4.0 - Quick access shortcuts
6. ✅ v0.6.0 - Visual analytics

### Tier 3: Nice-to-Have (Increasing UX)
7. ✅ v0.8.0 - Advanced metrics
8. ✅ v0.9.0 - Settings UI

### Tier 4: Future Scope (Post 1.0)
9. ✅ Team features
10. ✅ Cloud sync
11. ✅ API integration

---

## 💼 Development Workflow

### Weekly Cycle
- **Monday**: Feature planning & design
- **Tuesday-Thursday**: Development
- **Friday**: Testing & bug fixes
- **Saturday**: Package & publish
- **Sunday**: Documentation & changelog

### Code Review Checklist
- [ ] Code follows project style guide
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] CHANGELOG.md entry added
- [ ] Version bump in package.json
- [ ] No console errors or warnings

### Testing Strategy
- Manual testing each release
- GitHub issue tracking for bugs
- Beta releases for major features (optional)
- User feedback collection

### Release Checklist
- [ ] Version bumped in package.json
- [ ] CHANGELOG.md updated
- [ ] README.md updated if needed
- [ ] All tests passing
- [ ] Code linted and formatted
- [ ] Build succeeds: `npm run package`
- [ ] Package created: `vsce package`
- [ ] Tested locally with VSIX
- [ ] Published to Marketplace: `vsce publish`
- [ ] Git tag created: `git tag v0.X.0`
- [ ] GitHub release created

---

## 📝 Documentation Requirements

### Each Release Needs
- **CHANGELOG.md**: What's new, bugs fixed, breaking changes
- **README.md**: Update feature list if applicable
- **Inline comments**: For complex logic
- **Commit messages**: Follow conventional commits:
  - `feat: Add X feature`
  - `fix: Fix X bug`
  - `docs: Update X documentation`
  - `refactor: Improve X code`
  - `test: Add X tests`

### Version 1.0.0 Requires
- **API.md**: Public API documentation
- **DEVELOPMENT.md**: How to set up dev environment
- **CONTRIBUTING.md**: Contribution guidelines
- **Inline JSDoc**: For all exported functions

---

## 🔧 Technical Considerations

### Performance
- Minimize file I/O frequency
- Cache parsed messages
- Lazy load UI components
- Debounce rapid notifications

### Storage
- Use `~/.claude-statusbar/` for data
- Keep history.json reasonably sized (consider archiving old data)
- No data sent to external services

### Security
- Validate all file paths (no path traversal)
- Sanitize history/settings data
- No sensitive data in logs
- Handle errors gracefully

### Compatibility
- Support Windows, macOS, Linux
- Handle different Claude data paths
- Respect VS Code themes
- Accessible color choices

---

## ❓ Key Decisions

1. **Weekly releases**: Sustainable pace vs faster iterations?
   - Decision: Weekly is sustainable and manageable

2. **Which charting library for v0.6.0?**
   - Options: Chart.js (lighter), D3.js (powerful), custom SVG (smallest)
   - Decision: TBD - evaluate at week 4

3. **Cloud sync priority?**
   - Decision: Post-1.0, evaluate demand first

4. **Localization (i18n)?**
   - Decision: Prepare structure in 1.0.0, implement major languages later

---

## 📞 Feedback & Adjustments

This roadmap is flexible. Adjust based on:
- User feedback from GitHub issues
- Technical blockers discovered during dev
- Priority shifts from stakeholders
- Performance/stability issues

**Current Status**: ✅ Approved and ready for implementation

---

*Last updated: 2025-10-27*
*Next milestone: v0.2.2 (Session Reset Notifications)*
