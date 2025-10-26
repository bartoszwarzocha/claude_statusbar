import * as vscode from 'vscode';
import { SessionMetrics, PlanConfig } from './types';
import { formatTimeRemaining } from './sessionCalculator';
import { formatCost } from './pricing';

/**
 * Manages the status bar item showing session information
 * Format: Reset: HH:MM:SS | C: X.XX$/Y.XX$ | T: X/Y | M: X/Y
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
      this.statusBarItem.text = '$(clock) No Session';
      this.statusBarItem.tooltip = 'No active Claude Code session';
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const timeRemaining = session.isActive
      ? formatTimeRemaining(session.timeRemaining)
      : '00:00:00';

    // Format: Reset: HH:MM:SS | C: X.XX$/Y.XX$ | T: X/Y | M: X/Y
    const costText = `${formatCost(session.totalCost)}/${formatCost(session.costLimit)}`;
    const tokenText = `${session.totalTokens.toLocaleString()}/${planConfig.tokenLimit.toLocaleString()}`;
    const messageText = `${session.messageCount}/${session.messageLimit}`;

    this.statusBarItem.text =
      `Reset: ${timeRemaining} | ` +
      `C: ${costText} | ` +
      `T: ${tokenText} | ` +
      `M: ${messageText}`;

    // Build detailed tooltip
    const tokenPercent = (session.totalTokens / planConfig.tokenLimit) * 100;
    const costPercent = (session.totalCost / session.costLimit) * 100;
    const messagePercent = (session.messageCount / session.messageLimit) * 100;

    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `**Claude Code Usage Monitor**\n\n` +
        `**Session Timer**\n` +
        `- Started: ${session.startTime.toLocaleTimeString()}\n` +
        `- Ends: ${session.sessionEndTime.toLocaleTimeString()}\n` +
        `- Remaining: ${timeRemaining}\n\n` +
        `**Token Usage**\n` +
        `- Used: ${session.totalTokens.toLocaleString()} / ${planConfig.tokenLimit.toLocaleString()} (${tokenPercent.toFixed(1)}%)\n` +
        `- Input: ${session.inputTokens.toLocaleString()}\n` +
        `- Output: ${session.outputTokens.toLocaleString()}\n` +
        `- Cache (creation): ${session.cacheCreationTokens.toLocaleString()}\n` +
        `- Cache (read): ${session.cacheReadTokens.toLocaleString()}\n\n` +
        `**Cost**\n` +
        `- Used: ${formatCost(session.totalCost)} / ${formatCost(session.costLimit)} (${costPercent.toFixed(1)}%)\n\n` +
        `**Messages**\n` +
        `- Count: ${session.messageCount} / ${session.messageLimit} (${messagePercent.toFixed(1)}%)\n\n` +
        `**Burn Rates**\n` +
        `- Tokens: ${Math.round(session.tokenBurnRate)}/min\n` +
        `- Cost: ${formatCost(session.costBurnRate)}/min\n` +
        `- Messages: ${session.messageBurnRate.toFixed(1)}/min\n\n` +
        `_Click for detailed view_`
    );

    // Set color based on highest usage percentage
    const maxPercent = Math.max(tokenPercent, costPercent, messagePercent);

    if (maxPercent >= 80) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        maxPercent >= 100
          ? 'statusBarItem.errorBackground'
          : 'statusBarItem.warningBackground'
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  /**
   * Show initializing state
   */
  public showInitializing() {
    this.statusBarItem.text = '$(loading~spin) Initializing...';
    this.statusBarItem.tooltip = 'Claude Status Bar Monitor starting up...';
    this.statusBarItem.backgroundColor = undefined;
  }

  /**
   * Show error state
   */
  public showError(message: string) {
    this.statusBarItem.text = '$(error) Error';
    this.statusBarItem.tooltip = message;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.errorBackground'
    );
  }

  /**
   * Dispose of the status bar item
   */
  public dispose() {
    this.statusBarItem.dispose();
  }
}
