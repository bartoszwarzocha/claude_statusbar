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
      // If panel exists, update it to show "no session" state
      if (this.panel) {
        this.panel.reveal();
        this.showNoSession();
      } else {
        // No panel and no session - just show info message
        vscode.window.showInformationMessage('No active Claude Code session found');
      }
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
   * Show refreshing state
   */
  public showRefreshing() {
    if (this.panel) {
      this.panel.webview.postMessage({
        type: 'refreshing',
      });
    }
  }

  /**
   * Show no session state
   */
  public showNoSession() {
    if (this.panel) {
      this.panel.webview.postMessage({
        type: 'no-session',
      });
    }
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
            margin: 0;
            color: var(--vscode-textLink-foreground);
        }
        /* Odstęp między sekcjami */
        .section-header {
            margin-top: 5px;
        }
        /* Zachowaj odstęp pierwszej sekcji od timera */
        .session-timer + .section-header {
            margin-top: 20px;
        }
        /* Mniejsza czcionka dla nagłówków w rozwijanej sekcji */
        .collapsible-content h2 {
            font-size: 14px;
        }
        .metric-section {
            margin-bottom: 5px;
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
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            user-select: none;
        }
        .collapse-toggle {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
        }
        .collapse-arrow {
            display: inline-block;
            font-size: 14px;
            width: 14px;
            text-align: center;
            transition: transform 0.3s ease;
            margin-right: 6px;
        }
        .collapse-arrow.collapsed {
            transform: rotate(-90deg);
        }
        .collapsible-content {
            max-height: 500px;
            overflow: hidden;
            transition: max-height 0.3s ease, opacity 0.3s ease;
            opacity: 1;
            padding-bottom: 15px;
        }
        .collapsible-content.collapsed {
            max-height: 0;
            opacity: 0;
            padding-bottom: 0;
        }
        .stacked-bar {
            width: 100%;
            height: 30px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
            display: flex;
            position: relative;
        }
        .stacked-segment {
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 11px;
            transition: width 0.3s ease;
        }
        .breakdown-list {
            margin-top: 10px;
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 8px;
        }
        .breakdown-item {
            background-color: var(--vscode-input-background);
            padding: 8px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
        }
        .breakdown-color {
            width: 12px;
            height: 12px;
            border-radius: 2px;
            margin-right: 8px;
            flex-shrink: 0;
        }
        .breakdown-info {
            flex: 1;
            min-width: 0;
        }
        .breakdown-name {
            font-size: 11px;
            font-weight: bold;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .breakdown-value {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
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

        // Collapsible sections functionality
        function toggleSection(sectionId) {
            const content = document.getElementById(sectionId + '-content');
            const arrow = document.getElementById(sectionId + '-arrow');

            if (content && arrow) {
                content.classList.toggle('collapsed');
                arrow.classList.toggle('collapsed');

                // Save state to localStorage
                const isCollapsed = content.classList.contains('collapsed');
                localStorage.setItem('claude-section-' + sectionId, isCollapsed ? 'collapsed' : 'expanded');
            }
        }

        // Restore collapsed states from localStorage
        function restoreCollapsedStates() {
            const sections = ['token-details', 'cost-details', 'message-details'];
            sections.forEach(sectionId => {
                const state = localStorage.getItem('claude-section-' + sectionId);
                // If state is 'expanded', remove collapsed class
                if (state === 'expanded') {
                    const content = document.getElementById(sectionId + '-content');
                    const arrow = document.getElementById(sectionId + '-arrow');
                    if (content && arrow) {
                        content.classList.remove('collapsed');
                        arrow.classList.remove('collapsed');
                    }
                }
                // Otherwise keep default collapsed state
            });
        }

        // Restore states on load
        restoreCollapsedStates();

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

                // Show content if it was hidden
                document.getElementById('main-content').style.display = 'block';
                document.getElementById('refreshing-message').style.display = 'none';
                document.getElementById('no-session-message').style.display = 'none';
            } else if (message.type === 'refreshing') {
                // Show refreshing message
                document.getElementById('main-content').style.display = 'none';
                document.getElementById('refreshing-message').style.display = 'block';
                document.getElementById('no-session-message').style.display = 'none';
            } else if (message.type === 'no-session') {
                // Show no session message
                document.getElementById('main-content').style.display = 'none';
                document.getElementById('refreshing-message').style.display = 'none';
                document.getElementById('no-session-message').style.display = 'block';
            }
        });

        function updateMetrics(session, planConfig) {
            const tokenPercent = (session.totalTokens / planConfig.tokenLimit) * 100;
            const costPercent = (session.totalCost / session.costLimit) * 100;
            const messagePercent = (session.messageCount / session.messageLimit) * 100;

            // Update session times (CRITICAL: this fixes stale times after laptop sleep/resume)
            const startTime = new Date(session.startTime).toLocaleString();
            const endTime = new Date(session.sessionEndTime).toLocaleString();
            updateValue('session-times', 'Started: ' + startTime + ' • Ends: ' + endTime);

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

            // Model breakdown
            if (session.modelBreakdown) {
                const modelSegments = [
                    { name: 'Opus', value: session.modelBreakdown.opus, color: MODEL_COLORS.opus },
                    { name: 'Sonnet', value: session.modelBreakdown.sonnet, color: MODEL_COLORS.sonnet },
                    { name: 'Haiku', value: session.modelBreakdown.haiku, color: MODEL_COLORS.haiku }
                ].filter(s => s.value > 0).map(s => ({
                    ...s,
                    percent: (s.value / session.totalTokens) * 100
                }));

                renderStackedBar('model-stacked-bar', modelSegments);
                renderBreakdownList('model-breakdown-list', modelSegments);
            }

            // Project breakdown
            if (session.projectBreakdown) {
                const projectSegments = Object.entries(session.projectBreakdown)
                    .filter(([name, value]) => value > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, value]) => ({
                        name: name,
                        value: value,
                        color: stringToColor(name),
                        percent: (value / session.totalTokens) * 100
                    }));

                renderStackedBar('project-stacked-bar', projectSegments);
                renderBreakdownList('project-breakdown-list', projectSegments);
            }
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

        // Generate color from string hash (for projects)
        function stringToColor(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            const hue = Math.abs(hash % 360);
            return 'hsl(' + hue + ', 65%, 55%)';
        }

        // Model colors
        const MODEL_COLORS = {
            opus: '#ff6b6b',
            sonnet: '#4dabf7',
            haiku: '#51cf66'
        };

        // Render stacked bar
        function renderStackedBar(containerId, segments) {
            const container = document.getElementById(containerId);
            if (!container) return;

            container.innerHTML = '';

            segments.forEach(segment => {
                if (segment.percent > 0) {
                    const div = document.createElement('div');
                    div.className = 'stacked-segment';
                    div.style.width = segment.percent + '%';
                    div.style.backgroundColor = segment.color;
                    // Only show label if segment is big enough
                    if (segment.percent > 10) {
                        div.textContent = segment.percent.toFixed(1) + '%';
                    }
                    container.appendChild(div);
                }
            });
        }

        // Render breakdown list
        function renderBreakdownList(containerId, items) {
            const container = document.getElementById(containerId);
            if (!container) return;

            container.innerHTML = '';

            items.forEach(item => {
                const div = document.createElement('div');
                div.className = 'breakdown-item';
                div.innerHTML = '<div class="breakdown-color" style="background-color: ' + item.color + ';"></div>' +
                    '<div class="breakdown-info">' +
                    '<div class="breakdown-name">' + item.name + '</div>' +
                    '<div class="breakdown-value">' + item.value.toLocaleString() + ' tokens (' + item.percent.toFixed(1) + '%)</div>' +
                    '</div>';
                container.appendChild(div);
            });
        }

        // Initialize breakdowns on page load
        (function initBreakdowns() {
            const session = ${JSON.stringify({
              totalTokens: session.totalTokens,
              modelBreakdown: session.modelBreakdown,
              projectBreakdown: session.projectBreakdown
            })};

            // Model breakdown
            if (session.modelBreakdown) {
                const modelSegments = [
                    { name: 'Opus', value: session.modelBreakdown.opus, color: MODEL_COLORS.opus },
                    { name: 'Sonnet', value: session.modelBreakdown.sonnet, color: MODEL_COLORS.sonnet },
                    { name: 'Haiku', value: session.modelBreakdown.haiku, color: MODEL_COLORS.haiku }
                ].filter(s => s.value > 0).map(s => ({
                    ...s,
                    percent: (s.value / session.totalTokens) * 100
                }));

                renderStackedBar('model-stacked-bar', modelSegments);
                renderBreakdownList('model-breakdown-list', modelSegments);
            }

            // Project breakdown
            if (session.projectBreakdown) {
                const projectSegments = Object.entries(session.projectBreakdown)
                    .filter(([name, value]) => value > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, value]) => ({
                        name: name,
                        value: value,
                        color: stringToColor(name),
                        percent: (value / session.totalTokens) * 100
                    }));

                renderStackedBar('project-stacked-bar', projectSegments);
                renderBreakdownList('project-breakdown-list', projectSegments);
            }
        })();
    </script>
</head>
<body>
    <h1>Claude Code Statistics</h1>

    <div id="refreshing-message" style="display: none; text-align: center; padding: 50px;">
        <h2>Refreshing Session...</h2>
        <p style="color: var(--vscode-descriptionForeground);">Checking for new session data</p>
        <div style="margin-top: 20px; font-size: 24px;">$(sync~spin)</div>
    </div>

    <div id="no-session-message" style="display: none; text-align: center; padding: 50px;">
        <h2>No Active Session</h2>
        <p style="color: var(--vscode-descriptionForeground);">No active Claude Code session detected</p>
        <p style="color: var(--vscode-descriptionForeground); margin-top: 10px;">Start a conversation with Claude to activate a new tracking session</p>
    </div>

    <div id="main-content">
    <div class="session-timer">
        <div class="info-label">TIME UNTIL SESSION RESET</div>
        <div class="timer-value" id="timer-value">${timeRemaining}</div>
        <div class="progress-bar">
            <div class="progress-fill" id="time-progress-fill" style="width: ${timePercent}%; background-color: #60a5fa;">
            </div>
        </div>
        <div class="info-label" id="session-times">Started: ${session.startTime.toLocaleString()} • Ends: ${session.sessionEndTime.toLocaleString()}</div>
    </div>

    <div class="section-header" onclick="toggleSection('token-details')">
        <h2>Token Usage</h2>
        <div class="collapse-toggle">
            <span class="collapse-arrow collapsed" id="token-details-arrow">▼</span>More...
        </div>
    </div>
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
        <div class="collapsible-content collapsed" id="token-details-content">
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

            <h2 style="margin-top: 20px;">Token Usage by Model</h2>
            <div class="stacked-bar" id="model-stacked-bar"></div>
            <div class="breakdown-list" id="model-breakdown-list"></div>

            <h2 style="margin-top: 20px;">Token Usage by Project</h2>
            <div class="stacked-bar" id="project-stacked-bar"></div>
            <div class="breakdown-list" id="project-breakdown-list"></div>
        </div>
    </div>

    <div class="section-header" onclick="toggleSection('cost-details')">
        <h2>Cost Usage</h2>
        <div class="collapse-toggle">
            <span class="collapse-arrow collapsed" id="cost-details-arrow">▼</span>More...
        </div>
    </div>
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
        <div class="collapsible-content collapsed" id="cost-details-content">
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
    </div>

    <div class="section-header" onclick="toggleSection('message-details')">
        <h2>Message Count</h2>
        <div class="collapse-toggle">
            <span class="collapse-arrow collapsed" id="message-details-arrow">▼</span>More...
        </div>
    </div>
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
        <div class="collapsible-content collapsed" id="message-details-content">
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">Message Burn Rate</div>
                    <div class="info-value" id="message-burn-rate">${session.messageBurnRate.toFixed(1)} msg/min</div>
                </div>
            </div>
        </div>
    </div>
    </div><!-- end main-content -->
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
