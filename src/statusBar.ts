import * as vscode from 'vscode';
import { SessionMetrics, PlanConfig } from './types';
import { formatTimeRemaining } from './sessionCalculator';
import { formatCost } from './pricing';
import { budgetPercent } from './plans';

/**
 * Manages the status bar item showing session information.
 *
 * Two display modes:
 *  - Bridge active (real data from Claude Code):
 *      Reset: HH:MM:SS | 5h: 23% | 7d: 41% | C: $12.56
 *  - Estimates only:
 *      Reset: HH:MM:SS | C: $12.56 | T: 65.5k | M: 255
 *    (with "/budget" and a percentage appended for whichever budgets are set)
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'claude-statusbar.showDetails';
    this.statusBarItem.show();
  }

  /**
   * Update status bar with session metrics
   */
  public update(session: SessionMetrics | null, planConfig: PlanConfig) {
    if (!session) {
      this.statusBarItem.text = '$(claude-icon) No Session';
      this.statusBarItem.tooltip = 'No active Claude Code session';
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const timeRemaining = session.isActive
      ? formatTimeRemaining(session.timeRemaining)
      : '00:00:00';

    const parts: string[] = [`Reset: ${timeRemaining}`];

    const fiveHour = session.rateLimits?.fiveHour;
    const sevenDay = session.rateLimits?.sevenDay;

    if (fiveHour) {
      parts.push(`5h: ${fiveHour.usedPercent.toFixed(0)}%`);
    }
    if (sevenDay) {
      parts.push(`7d: ${sevenDay.usedPercent.toFixed(0)}%`);
    }

    // Cost is always shown - it is computed from real token counts and prices
    const costPercent = budgetPercent(session.totalCost, session.costLimit);
    parts.push(
      costPercent === undefined
        ? `C: ${formatCost(session.totalCost)}`
        : `C: ${formatCost(session.totalCost)}/${formatCost(session.costLimit!)}`
    );

    // Without real rate limit data, fall back to token/message counters
    if (!fiveHour && !sevenDay) {
      const tokenPercent = budgetPercent(session.totalTokens, planConfig.tokenLimit);
      parts.push(
        tokenPercent === undefined
          ? `T: ${formatCompact(session.totalTokens)}`
          : `T: ${tokenPercent.toFixed(1)}%`
      );

      const messagePercent = budgetPercent(session.messageCount, session.messageLimit);
      parts.push(
        messagePercent === undefined
          ? `M: ${session.messageCount}`
          : `M: ${messagePercent.toFixed(1)}%`
      );
    }

    this.statusBarItem.text = `$(claude-icon)  ${parts.join(' | ')}`;

    // Colour on the most reliable signal available: the real 5-hour window,
    // then the weekly window, then whatever budget the user configured.
    const severityPercent = Math.max(
      fiveHour?.usedPercent ?? -1,
      sevenDay?.usedPercent ?? -1,
      !fiveHour && !sevenDay
        ? budgetPercent(session.totalTokens, planConfig.tokenLimit) ?? costPercent ?? -1
        : -1
    );

    if (severityPercent >= 60) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        severityPercent >= 80
          ? 'statusBarItem.errorBackground'
          : 'statusBarItem.warningBackground'
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }
    this.statusBarItem.color = undefined;
  }

  /**
   * Update only the tooltip (called less frequently to avoid flicker)
   */
  public updateTooltip(session: SessionMetrics, planConfig: PlanConfig) {
    const lines: string[] = ['**Claude Code Statistics**', ''];

    const fiveHour = session.rateLimits?.fiveHour;
    const sevenDay = session.rateLimits?.sevenDay;

    if (fiveHour || sevenDay) {
      // These come from the last status line render, which can be a while ago -
      // the VS Code extension renders none at all. Date the reading rather than
      // let a frozen percentage pass for a live one.
      const updatedAt = session.rateLimits?.updatedAt;
      const age = updatedAt ? Date.now() - updatedAt.getTime() : 0;
      const asOf = updatedAt && age >= 5 * 60 * 1000 ? ` as of ${updatedAt.toLocaleTimeString()}` : '';
      lines.push(`**Usage limits** _(reported by Claude Code${asOf})_`);
      if (fiveHour) {
        lines.push(
          `- 5-hour: ${fiveHour.usedPercent.toFixed(1)}% used, resets ${fiveHour.resetsAt.toLocaleTimeString()}`
        );
      }
      if (sevenDay) {
        lines.push(
          `- 7-day: ${sevenDay.usedPercent.toFixed(1)}% used, resets ${sevenDay.resetsAt.toLocaleString()}`
        );
      }
      if (asOf && session.sessionContexts?.some((row) => row.entrypoint === 'claude-vscode')) {
        lines.push(
          '- _A session is running in the VS Code extension, which renders no status line and reports no limits._'
        );
      }
      lines.push('');
    } else {
      lines.push(
        '**Usage limits**',
        '- Not enabled — run `Claude: Enable Real Usage Limits`',
        ''
      );
    }

    lines.push(
      '**Session Timer**',
      `- Started: ${session.startTime.toLocaleTimeString()}`,
      `- Ends: ${session.sessionEndTime.toLocaleTimeString()}`,
      '',
      '**Cost** _(estimated from current published prices)_',
      session.costLimit
        ? `- Session: ${formatCost(session.totalCost)} / ${formatCost(session.costLimit)} (${(budgetPercent(session.totalCost, session.costLimit) ?? 0).toFixed(1)}% of budget)`
        : `- Session: ${formatCost(session.totalCost)}`,
      `- Last 7 days: ${formatCost(session.weekCost)}`,
      ''
    );

    const tokenPercent = budgetPercent(session.totalTokens, planConfig.tokenLimit);
    lines.push(
      '**Tokens** _(input + output; cache excluded from limits)_',
      tokenPercent === undefined
        ? `- Session: ${session.totalTokens.toLocaleString()}`
        : `- Session: ${session.totalTokens.toLocaleString()} / ${planConfig.tokenLimit!.toLocaleString()} (${tokenPercent.toFixed(1)}% of budget)`,
      `- Cache written: ${session.cacheCreationTokens.toLocaleString()} (${session.cacheCreation1hTokens.toLocaleString()} at 1h rate)`,
      `- Cache read: ${session.cacheReadTokens.toLocaleString()}`,
      ''
    );

    const messagePercent = budgetPercent(session.messageCount, session.messageLimit);
    lines.push(
      '**Messages**',
      messagePercent === undefined
        ? `- Count: ${session.messageCount}`
        : `- Count: ${session.messageCount} / ${session.messageLimit} (${messagePercent.toFixed(1)}% of budget)`,
      '',
      '**Burn rates**',
      `- Tokens: ${Math.round(session.tokenBurnRate)}/min`,
      `- Cost: ${formatCost(session.costBurnRate)}/min`,
      `- Messages: ${session.messageBurnRate.toFixed(1)}/min`,
      '',
      '_Click for detailed view_'
    );

    this.statusBarItem.tooltip = new vscode.MarkdownString(lines.join('\n'));
  }

  /**
   * Show initializing state
   */
  public showInitializing() {
    this.statusBarItem.text = '$(claude-icon) Initializing...';
    this.statusBarItem.tooltip = 'Claude Status Bar Monitor starting up...';
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.color = undefined;
  }

  /**
   * Show error state
   */
  public showError(message: string) {
    this.statusBarItem.text = '$(claude-icon) Error';
    this.statusBarItem.tooltip = message;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.errorBackground'
    );
    this.statusBarItem.color = undefined;
  }

  /**
   * Dispose of the status bar item
   */
  public dispose() {
    this.statusBarItem.dispose();
  }
}

/** 65489 -> "65.5k" */
function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return value.toString();
}
