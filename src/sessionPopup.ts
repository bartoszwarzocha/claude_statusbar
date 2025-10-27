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
      // Send updated data to existing panel
      this.panel.webview.postMessage({
        type: 'update',
        session,
        planConfig,
      });
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'claudeUsageDetails',
        'Claude Code Statistics',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });

      // Set initial HTML content
      this.panel.webview.html = this.getWebviewContent(session, planConfig);
    }
  }

  /**
   * Update the panel content if it's open (using postMessage instead of full HTML reload)
   */
  public update(session: SessionMetrics | null, planConfig: PlanConfig) {
    if (this.panel && session) {
      this.panel.webview.postMessage({
        type: 'update',
        session,
        planConfig,
      });
    }
  }

  /**
   * Check if panel is currently open
   */
  public isOpen(): boolean {
    return this.panel !== undefined;
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

    // Calculate time progress percentage
    const totalSessionTime = 5 * 60 * 60 * 1000; // 5 hours
    const elapsedTime = totalSessionTime - session.timeRemaining;
    const timePercent = Math.min((elapsedTime / totalSessionTime) * 100, 100);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Code Statistics</title>
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
            grid-template-columns: 1fr 1fr 1fr;
            gap: 10px;
            margin-top: 10px;
        }
        .info-item {
            background-color: var(--vscode-input-background);
            padding: 6px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }
        .info-label {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        .info-value {
            font-size: 12px;
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
        .session-timer .progress-bar {
            margin-bottom: 12px;
        }
    </style>
    <script>
        // Store session end time for local countdown
        let sessionEndTime = new Date('${session.sessionEndTime.toISOString()}').getTime();
        const totalSessionTime = 5 * 60 * 60 * 1000; // 5 hours

        // Update timer display locally every second
        function updateTimer() {
            const now = Date.now();
            const timeRemaining = Math.max(0, sessionEndTime - now);

            // Format time remaining
            const totalSeconds = Math.floor(timeRemaining / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const timeStr = hours.toString().padStart(2, '0') + ':' +
                           minutes.toString().padStart(2, '0') + ':' +
                           seconds.toString().padStart(2, '0');

            // Update timer value
            const timerElem = document.getElementById('timer-value');
            if (timerElem) {
                timerElem.textContent = timeStr;
            }

            // Update progress bar
            const elapsedTime = totalSessionTime - timeRemaining;
            const timePercent = Math.min((elapsedTime / totalSessionTime) * 100, 100);
            const timeProgressElem = document.getElementById('time-progress-fill');
            if (timeProgressElem) {
                timeProgressElem.style.width = timePercent + '%';
            }
        }

        // Start local timer
        setInterval(updateTimer, 1000);
        updateTimer(); // Initial update

        // Listen for updates from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                const session = message.session;
                const planConfig = message.planConfig;

                // Update session end time
                sessionEndTime = new Date(session.sessionEndTime).getTime();

                // Update all metrics
                updateMetrics(session, planConfig);
            }
        });

        function updateMetrics(session, planConfig) {
            const tokenPercent = (session.totalTokens / planConfig.tokenLimit) * 100;
            const costPercent = (session.totalCost / session.costLimit) * 100;
            const messagePercent = (session.messageCount / session.messageLimit) * 100;

            // Token usage
            updateProgress('token', session.totalTokens.toLocaleString(), planConfig.tokenLimit.toLocaleString(), tokenPercent, 'tokens');
            updateValue('input-tokens', session.inputTokens.toLocaleString());
            updateValue('output-tokens', session.outputTokens.toLocaleString());
            updateValue('cache-creation', session.cacheCreationTokens.toLocaleString());
            updateValue('cache-read', session.cacheReadTokens.toLocaleString());
            updateValue('token-burn-rate', Math.round(session.tokenBurnRate) + ' tokens/min');

            // Cost usage - format as currency
            const costCurrent = '$' + session.totalCost.toFixed(2);
            const costLimit = '$' + session.costLimit.toFixed(2);
            updateProgress('cost', costCurrent, costLimit, costPercent, '');
            updateValue('cost-burn-rate', '$' + session.costBurnRate.toFixed(4) + '/min');

            // Message count
            updateProgress('message', session.messageCount, session.messageLimit, messagePercent, 'messages');
            updateValue('message-burn-rate', session.messageBurnRate.toFixed(1) + ' msg/min');
        }

        function updateProgress(id, current, limit, percent, unit) {
            const labelElem = document.getElementById(id + '-label');
            const percentElem = document.getElementById(id + '-percent');
            const fillElem = document.getElementById(id + '-fill');
            const textElem = document.getElementById(id + '-fill-text');

            const unitStr = unit ? ' ' + unit : '';
            if (labelElem) {
                labelElem.innerHTML = '<strong>' + current + '</strong> / ' + limit + unitStr;
            }
            if (percentElem) {
                percentElem.innerHTML = '<strong>' + percent.toFixed(1) + '%</strong>';
            }
            if (fillElem) {
                fillElem.style.width = Math.min(percent, 100) + '%';
            }
            if (textElem) {
                textElem.textContent = percent.toFixed(1) + '%';
            }
        }

        function updateValue(id, value) {
            const elem = document.getElementById(id);
            if (elem) elem.textContent = value;
        }
    </script>
</head>
<body>
    <h1>Claude Code Statistics</h1>

    <div class="session-timer">
        <div class="info-label">TIME UNTIL SESSION RESET</div>
        <div class="timer-value" id="timer-value">${timeRemaining}</div>
        <div class="progress-bar">
            <div class="progress-fill" id="time-progress-fill" style="width: ${timePercent}%; background-color: #60a5fa;">
            </div>
        </div>
        <div class="info-label">Started: ${session.startTime.toLocaleString()} • Ends: ${session.sessionEndTime.toLocaleString()}</div>
    </div>

    <h2>Token Usage</h2>
    <div class="metric-section">
        <div class="progress-container">
            <div class="progress-label">
                <span id="token-label"><strong>${session.totalTokens.toLocaleString()}</strong> / ${planConfig.tokenLimit.toLocaleString()} tokens</span>
                <span id="token-percent"><strong>${tokenPercent.toFixed(1)}%</strong></span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" id="token-fill" style="width: ${Math.min(tokenPercent, 100)}%; background-color: ${tokenColor};">
                    <span id="token-fill-text">${tokenPercent.toFixed(1)}%</span>
                </div>
            </div>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Input Tokens</div>
                <div class="info-value" id="input-tokens">${session.inputTokens.toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Output Tokens</div>
                <div class="info-value" id="output-tokens">${session.outputTokens.toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Cache Creation</div>
                <div class="info-value" id="cache-creation">${session.cacheCreationTokens.toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Cache Read</div>
                <div class="info-value" id="cache-read">${session.cacheReadTokens.toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Burn Rate</div>
                <div class="info-value" id="token-burn-rate">${Math.round(session.tokenBurnRate)} tokens/min</div>
            </div>
        </div>
    </div>

    <h2>Cost Usage</h2>
    <div class="metric-section">
        <div class="progress-container">
            <div class="progress-label">
                <span id="cost-label"><strong>${formatCost(session.totalCost)}</strong> / ${formatCost(session.costLimit)}</span>
                <span id="cost-percent"><strong>${costPercent.toFixed(1)}%</strong></span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" id="cost-fill" style="width: ${Math.min(costPercent, 100)}%; background-color: ${costColor};">
                    <span id="cost-fill-text">${costPercent.toFixed(1)}%</span>
                </div>
            </div>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Cost Burn Rate</div>
                <div class="info-value" id="cost-burn-rate">${formatCost(session.costBurnRate)}/min</div>
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
                <span id="message-label"><strong>${session.messageCount}</strong> / ${session.messageLimit} messages</span>
                <span id="message-percent"><strong>${messagePercent.toFixed(1)}%</strong></span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" id="message-fill" style="width: ${Math.min(messagePercent, 100)}%; background-color: ${messageColor};">
                    <span id="message-fill-text">${messagePercent.toFixed(1)}%</span>
                </div>
            </div>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Message Burn Rate</div>
                <div class="info-value" id="message-burn-rate">${session.messageBurnRate.toFixed(1)} msg/min</div>
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
