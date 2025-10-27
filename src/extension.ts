import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { StatusBarManager } from './statusBar';
import { SessionPopupPanel } from './sessionPopup';
import { parseSessionFile } from './sessionParser';
import { calculateSessionMetrics } from './sessionCalculator';
import { SessionMetrics, PlanConfig } from './types';
import { getPlanConfig } from './plans';

export function activate(context: vscode.ExtensionContext) {
  console.log('Claude Status Bar Monitor is now active!');

  // Create output channel for debugging
  const outputChannel = vscode.window.createOutputChannel('Claude Status Bar Debug');
  outputChannel.appendLine('='.repeat(80));
  outputChannel.appendLine('Claude Status Bar Monitor activated');
  outputChannel.appendLine('='.repeat(80));

  // Initialize components
  const statusBar = new StatusBarManager();
  const popupPanel = new SessionPopupPanel(context.extensionUri);

  // Load configuration
  let planConfig = loadPlanConfig();

  // State
  let currentSession: SessionMetrics | null = null;
  let isRefreshing = false;
  let sessionJustEnded = false;
  let refreshingStartTime: number | null = null;

  statusBar.showInitializing();

  // Find Claude data directories
  const claudeDataPaths = getClaudeDataPaths();

  if (claudeDataPaths.length === 0) {
    statusBar.showError('Claude data directory not found');
    vscode.window.showWarningMessage(
      'Claude data directory not found. Make sure Claude Code is installed and has been used at least once.'
    );
    return;
  }

  console.log(`Found Claude data paths: ${claudeDataPaths.join(', ')}`);

  /**
   * Collect all messages from all session files across ALL projects
   */
  async function updateMetrics() {
    try {
      const timestamp = new Date().toLocaleTimeString();
      outputChannel.appendLine('');
      outputChannel.appendLine(`[${timestamp}] ========== UPDATE METRICS ==========`);

      const allMessages: any[] = [];

      // Step 1: Use ONLY the first data path (like Python does: data_path = data_paths[0])
      const basePath = claudeDataPaths[0];
      if (!basePath || !fs.existsSync(basePath)) {
        outputChannel.appendLine('WARNING: No valid Claude data path found');
        currentSession = null;
        statusBar.update(null, planConfig);
        return;
      }

      outputChannel.appendLine(`Using data path: ${basePath}`);

      const projectDirs = fs.readdirSync(basePath);

      // Collect from ALL projects in this data path
      for (const projectDir of projectDirs) {
        const projectPath = path.join(basePath, projectDir);

        if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
          continue;
        }

        const files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));

        // Read each session file
        for (const file of files) {
          const filePath = path.join(projectPath, file);

          try {
            const messages = await parseSessionFile(filePath, projectDir);
            allMessages.push(...messages);
          } catch (err) {
            // Skip files that can't be parsed
            console.warn(`Skipping ${filePath}:`, err);
          }
        }
      }

      outputChannel.appendLine(`Collected ${allMessages.length} total messages from all files`);

      if (allMessages.length === 0) {
        outputChannel.appendLine('WARNING: No messages found');
        currentSession = null;
        statusBar.update(null, planConfig);
        return;
      }

      // Step 2: Calculate metrics (pass output channel for detailed logging)
      outputChannel.appendLine('Calculating session metrics...');
      const metrics = calculateSessionMetrics(allMessages, 'combined', planConfig, outputChannel);

      if (metrics && metrics.isActive) {
        outputChannel.appendLine('');
        outputChannel.appendLine('ACTIVE SESSION FOUND:');
        outputChannel.appendLine(`  Started: ${metrics.startTime.toLocaleString()}`);
        outputChannel.appendLine(`  Last activity: ${metrics.lastMessageTime.toLocaleString()}`);
        outputChannel.appendLine(`  Tokens: ${metrics.totalTokens} / ${planConfig.tokenLimit} (${((metrics.totalTokens / planConfig.tokenLimit) * 100).toFixed(1)}%)`);
        outputChannel.appendLine(`  Cost: $${metrics.totalCost.toFixed(2)} / $${metrics.costLimit.toFixed(2)} (${((metrics.totalCost / metrics.costLimit) * 100).toFixed(1)}%)`);
        outputChannel.appendLine(`  Messages: ${metrics.messageCount} / ${metrics.messageLimit} (${((metrics.messageCount / metrics.messageLimit) * 100).toFixed(1)}%)`);

        currentSession = metrics;
        isRefreshing = false;
        sessionJustEnded = false;
        refreshingStartTime = null;
        statusBar.update(currentSession, planConfig);
        statusBar.updateTooltip(currentSession, planConfig);

        // Update popup panel if open
        if (popupPanel.isOpen()) {
          popupPanel.update(currentSession, planConfig);
        }
      } else {
        outputChannel.appendLine('WARNING: No active sessions');

        // Show warning if session just ended and no new session detected after 30 seconds
        if (sessionJustEnded && refreshingStartTime) {
          const elapsedTime = Date.now() - refreshingStartTime;

          if (elapsedTime >= 30000) {
            // 30 seconds passed without detecting new session
            const config = vscode.workspace.getConfiguration('claudeStatusBar');
            const notifyNoNewSession = config.get<boolean>(
              'notifications.noNewSessionWarning',
              true
            );

            if (notifyNoNewSession) {
              vscode.window.showWarningMessage(
                '⚠️ No new session detected\nClaude Code appears to be inactive. Start a new conversation to begin tracking.',
                'OK'
              );
            }
            sessionJustEnded = false;
            refreshingStartTime = null;
          }
          // If < 30s, keep waiting (will check again in next updateMetrics cycle)
        }

        currentSession = null;
        isRefreshing = false;
        statusBar.update(null, planConfig);

        // Update popup panel if open
        if (popupPanel.isOpen()) {
          popupPanel.showNoSession();
        }
      }
    } catch (error) {
      outputChannel.appendLine(`ERROR: ${error}`);
      outputChannel.appendLine(`Stack: ${error instanceof Error ? error.stack : 'N/A'}`);
    }
  }

  // Update immediately
  updateMetrics();

  // Get refresh interval from settings (1-60 seconds)
  const config = vscode.workspace.getConfiguration('claudeStatusBar');
  const refreshInterval = Math.max(1, Math.min(60, config.get<number>('refreshInterval', 5)));

  // Update at configured interval for metrics
  const metricsInterval = setInterval(updateMetrics, refreshInterval * 1000);

  // Update status bar every second to refresh timer dynamically
  const timerInterval = setInterval(() => {
    if (currentSession && currentSession.isActive) {
      // Recalculate timeRemaining dynamically for live countdown
      const now = new Date();
      const timeRemaining = Math.max(0, currentSession.sessionEndTime.getTime() - now.getTime());
      const updatedSession = {
        ...currentSession,
        timeRemaining,
      };

      // If timer reached 0 and we're not already refreshing, trigger immediate refresh
      if (timeRemaining === 0 && !isRefreshing) {
        isRefreshing = true;
        sessionJustEnded = true;
        refreshingStartTime = Date.now(); // Start 30s countdown
        statusBar.showRefreshing();
        if (popupPanel.isOpen()) {
          popupPanel.showRefreshing();
        }

        // Show notification if enabled
        const config = vscode.workspace.getConfiguration('claudeStatusBar');
        const notifyOnSessionEnded = config.get<boolean>(
          'notifications.sessionEnded',
          true
        );

        if (notifyOnSessionEnded) {
          vscode.window.showInformationMessage(
            '🔄 Claude session ended\nStatistics have been reset. Waiting for new session...',
            'OK'
          );
        }

        // Trigger immediate metrics update
        setTimeout(() => updateMetrics(), 100);
      } else {
        statusBar.update(updatedSession, planConfig);

        // Also update the popup panel if it's open
        if (popupPanel.isOpen()) {
          popupPanel.update(updatedSession, planConfig);
        }
      }
    } else if (currentSession) {
      statusBar.update(currentSession, planConfig);

      if (popupPanel.isOpen()) {
        popupPanel.update(currentSession, planConfig);
      }
    }
  }, 1000);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(metricsInterval);
      clearInterval(timerInterval);
    },
  });

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeStatusBar')) {
        planConfig = loadPlanConfig();
        updateMetrics();
      }
    })
  );

  // Set up file watching for real-time updates
  const watchers: chokidar.FSWatcher[] = [];
  for (const basePath of claudeDataPaths) {
    if (fs.existsSync(basePath)) {
      const watcher = chokidar.watch(`${basePath}/**/*.jsonl`, {
        persistent: true,
        ignoreInitial: true,
      });

      watcher.on('change', () => {
        console.log('📝 File change detected, updating metrics...');
        updateMetrics();
      });

      watchers.push(watcher);
    }
  }

  context.subscriptions.push({
    dispose: () => {
      watchers.forEach((w) => w.close());
    },
  });

  // Helper function to update plan
  async function updatePlan(
    plan: 'pro' | 'max5' | 'max20' | 'custom',
    customTokenLimit?: number
  ) {
    const config = vscode.workspace.getConfiguration('claudeStatusBar');
    await config.update('plan', plan, vscode.ConfigurationTarget.Global);

    if (plan === 'custom' && customTokenLimit) {
      await config.update(
        'customTokenLimit',
        customTokenLimit,
        vscode.ConfigurationTarget.Global
      );
    }

    planConfig = loadPlanConfig();
    statusBar.update(currentSession, planConfig);

    const planLimits = getPlanConfig(plan, customTokenLimit);
    vscode.window.showInformationMessage(
      `Claude plan set to ${plan.toUpperCase()} ` +
        `(${planLimits.tokenLimit.toLocaleString()} tokens, ` +
        `$${planLimits.costLimit.toFixed(2)}, ` +
        `${planLimits.messageLimit} messages)`
    );
  }

  // Register commands
  const showDetails = vscode.commands.registerCommand(
    'claude-statusbar.showDetails',
    () => {
      popupPanel.show(currentSession, planConfig);
    }
  );

  const setPlanPro = vscode.commands.registerCommand(
    'claude-statusbar.setPlanPro',
    () => {
      updatePlan('pro');
    }
  );

  const setPlanMax5 = vscode.commands.registerCommand(
    'claude-statusbar.setPlanMax5',
    () => {
      updatePlan('max5');
    }
  );

  const setPlanMax20 = vscode.commands.registerCommand(
    'claude-statusbar.setPlanMax20',
    () => {
      updatePlan('max20');
    }
  );

  const setPlanCustom = vscode.commands.registerCommand(
    'claude-statusbar.setPlanCustom',
    async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter custom token limit',
        placeHolder: '44000',
        validateInput: (value) => {
          const num = parseInt(value);
          if (isNaN(num) || num <= 0) {
            return 'Please enter a valid positive number';
          }
          return null;
        },
      });

      if (input) {
        const tokenLimit = parseInt(input);
        updatePlan('custom', tokenLimit);
      }
    }
  );

  const refresh = vscode.commands.registerCommand('claude-statusbar.refresh', () => {
    updateMetrics();
  });

  context.subscriptions.push(
    statusBar,
    popupPanel,
    showDetails,
    setPlanPro,
    setPlanMax5,
    setPlanMax20,
    setPlanCustom,
    refresh,
    outputChannel
  );
}

/**
 * Load plan configuration from VS Code settings
 */
function loadPlanConfig(): PlanConfig {
  const config = vscode.workspace.getConfiguration('claudeStatusBar');
  const plan = config.get<'pro' | 'max5' | 'max20' | 'custom'>('plan', 'max5');
  const customTokenLimit = config.get<number>('customTokenLimit', 44000);

  return getPlanConfig(plan, customTokenLimit);
}

/**
 * Get Claude data directory paths
 */
function getClaudeDataPaths(): string[] {
  const paths: string[] = [];

  // Check environment variable first
  const envPath = process.env.CLAUDE_CONFIG_DIR;
  if (envPath) {
    const projectsPath = path.join(envPath, 'projects');
    if (fs.existsSync(projectsPath)) {
      paths.push(projectsPath);
    }
  }

  // Standard paths
  const homeDir = os.homedir();
  const standardPaths = [
    path.join(homeDir, '.config', 'claude', 'projects'),
    path.join(homeDir, '.claude', 'projects'),
  ];

  for (const p of standardPaths) {
    if (fs.existsSync(p) && !paths.includes(p)) {
      paths.push(p);
    }
  }

  return paths;
}

export function deactivate() {}
