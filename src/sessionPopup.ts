import * as vscode from 'vscode';
import { SessionMetrics, PlanConfig } from './types';
import { formatTimeRemaining, getStatusColor } from './sessionCalculator';
import { formatCost } from './pricing';

/**
 * Manages the detailed popup/webview panel
 */
export class SessionPopupPanel {
  private panel: vscode.WebviewPanel | undefined;
  private extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  /**
   * Show the popup with detailed metrics
   */
  public show(session: SessionMetrics | null, planConfig: PlanConfig) {
    if (!session) {
      vscode.window.showInformationMessage('No active Claude Code session found');
      return;
    }

    // Create or show panel
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'claudeUsageDetails',
        'Claude Code Usage Details',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    // Update content
    this.panel.webview.html = this.getWebviewContent(session, planConfig);
  }

  /**
   * Generate HTML content for the webview
   */
  private getWebviewContent(session: SessionMetrics, planConfig: PlanConfig): string {
    const tokenPercent = (session.totalTokens / planConfig.tokenLimit) * 100;
    const costPercent = (session.totalCost / session.costLimit) * 100;
    const messagePercent = (session.messageCount / session.messageLimit) * 100;

    const tokenColor = getStatusColor(tokenPercent);
    const costColor = getStatusColor(costPercent);
    const messageColor = getStatusColor(messagePercent);

    const timeRemaining = formatTimeRemaining(session.timeRemaining);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Code Usage Details</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }
        h1 {
            font-size: 24px;
            margin-bottom: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
        }
        h2 {
            font-size: 18px;
            margin-top: 30px;
            margin-bottom: 15px;
            color: var(--vscode-textLink-foreground);
        }
        .metric-section {
            margin-bottom: 25px;
        }
        .progress-container {
            margin-bottom: 20px;
        }
        .progress-label {
            display: flex;
            justify-content: space-between;
            margin-bottom: 5px;
            font-size: 14px;
        }
        .progress-bar {
            width: 100%;
            height: 30px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
            position: relative;
        }
        .progress-fill {
            height: 100%;
            transition: width 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 13px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-top: 10px;
        }
        .info-item {
            background-color: var(--vscode-input-background);
            padding: 12px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }
        .info-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 5px;
        }
        .info-value {
            font-size: 16px;
            font-weight: bold;
        }
        .session-timer {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
            text-align: center;
        }
        .timer-value {
            font-size: 32px;
            font-weight: bold;
            margin: 10px 0;
        }
    </style>
</head>
<body>
    <h1>Claude Code Usage Monitor</h1>

    <div class="session-timer">
        <div class="info-label">TIME UNTIL SESSION RESET</div>
        <div class="timer-value">${timeRemaining}</div>
        <div class="info-label">Started: ${session.startTime.toLocaleString()} • Ends: ${session.sessionEndTime.toLocaleString()}</div>
    </div>

    <h2>Token Usage</h2>
    <div class="metric-section">
        <div class="progress-container">
            <div class="progress-label">
                <span><strong>${session.totalTokens.toLocaleString()}</strong> / ${planConfig.tokenLimit.toLocaleString()} tokens</span>
                <span><strong>${tokenPercent.toFixed(1)}%</strong></span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${Math.min(tokenPercent, 100)}%; background-color: ${tokenColor};">
                    ${tokenPercent.toFixed(1)}%
                </div>
            </div>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Input Tokens</div>
                <div class="info-value">${session.inputTokens.toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Output Tokens</div>
                <div class="info-value">${session.outputTokens.toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Cache Creation</div>
                <div class="info-value">${session.cacheCreationTokens.toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Cache Read</div>
                <div class="info-value">${session.cacheReadTokens.toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Burn Rate</div>
                <div class="info-value">${Math.round(session.tokenBurnRate)} tokens/min</div>
            </div>
        </div>
    </div>

    <h2>Cost Usage</h2>
    <div class="metric-section">
        <div class="progress-container">
            <div class="progress-label">
                <span><strong>${formatCost(session.totalCost)}</strong> / ${formatCost(session.costLimit)}</span>
                <span><strong>${costPercent.toFixed(1)}%</strong></span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${Math.min(costPercent, 100)}%; background-color: ${costColor};">
                    ${costPercent.toFixed(1)}%
                </div>
            </div>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Cost Burn Rate</div>
                <div class="info-value">${formatCost(session.costBurnRate)}/min</div>
            </div>
            <div class="info-item">
                <div class="info-label">Plan</div>
                <div class="info-value">${planConfig.plan.toUpperCase()}</div>
            </div>
        </div>
    </div>

    <h2>Message Count</h2>
    <div class="metric-section">
        <div class="progress-container">
            <div class="progress-label">
                <span><strong>${session.messageCount}</strong> / ${session.messageLimit} messages</span>
                <span><strong>${messagePercent.toFixed(1)}%</strong></span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${Math.min(messagePercent, 100)}%; background-color: ${messageColor};">
                    ${messagePercent.toFixed(1)}%
                </div>
            </div>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Message Burn Rate</div>
                <div class="info-value">${session.messageBurnRate.toFixed(1)} msg/min</div>
            </div>
        </div>
    </div>
</body>
</html>`;
  }

  /**
   * Dispose of the panel
   */
  public dispose() {
    if (this.panel) {
      this.panel.dispose();
    }
  }
}
