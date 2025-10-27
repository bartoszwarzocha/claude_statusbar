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
      this.statusBarItem.text = '$(claude-icon) No Session';
      this.statusBarItem.tooltip = 'No active Claude Code session';
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const timeRemaining = session.isActive
      ? formatTimeRemaining(session.timeRemaining)
      : '00:00:00';

    // Calculate percentages
    const tokenPercent = (session.totalTokens / planConfig.tokenLimit) * 100;
    const costPercent = (session.totalCost / session.costLimit) * 100;
    const messagePercent = (session.messageCount / session.messageLimit) * 100;

    // Format: $(claude-icon) Reset: HH:MM:SS | C: XX.X% | T: XX.X% | M: XX.X%
    this.statusBarItem.text =
      `$(claude-icon)  Reset: ${timeRemaining} | ` +
      `C: ${costPercent.toFixed(1)}% | ` +
      `T: ${tokenPercent.toFixed(1)}% | ` +
      `M: ${messagePercent.toFixed(1)}%`;

    // Set background and foreground colors based on TOKEN usage percentage
    if (tokenPercent >= 75) {
      // Error (red) or Warning (orange) background
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        tokenPercent >= 90 ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground'
      );
      this.statusBarItem.color = undefined;
    } else {
      // Safe usage - remote/blue background (like WSL indicator)
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = undefined;
    }
  }

  /**
   * Update only the tooltip (called less frequently to avoid flicker)
   */
  public updateTooltip(session: SessionMetrics, planConfig: PlanConfig) {
    const tokenPercent = (session.totalTokens / planConfig.tokenLimit) * 100;
    const costPercent = (session.totalCost / session.costLimit) * 100;
    const messagePercent = (session.messageCount / session.messageLimit) * 100;

    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `**Claude Code Statistics**\n\n` +
        `**Session Timer**\n` +
        `- Started: ${session.startTime.toLocaleTimeString()}\n` +
        `- Ends: ${session.sessionEndTime.toLocaleTimeString()}\n\n` +
        `**Token Usage**\n` +
        `- Used: ${session.totalTokens.toLocaleString()} / ${planConfig.tokenLimit.toLocaleString()} (${tokenPercent.toFixed(1)}%)\n\n` +
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
   * Show refreshing state
   */
  public showRefreshing() {
    this.statusBarItem.text = '$(claude-icon) Refreshing...';
    this.statusBarItem.tooltip = 'Checking for new session...';
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
