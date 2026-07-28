import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { StatusBarManager } from './statusBar';
import { SessionPopupPanel } from './sessionPopup';
import { parseSessionFile } from './sessionParser';
import { calculateSessionMetrics } from './sessionCalculator';
import { ClaudeMessage, SessionMetrics, PlanConfig } from './types';
import { getPlanConfig } from './plans';
import {
  checkNodeAvailable,
  getBridgeStatus,
  getClaudeConfigDir,
  getRateLimitFilePath,
  installBridge,
  readRateLimits,
  uninstallBridge,
} from './rateLimits';

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
   * Parsed-message cache, keyed by file path.
   *
   * The full corpus grows without bound (100+ MB is normal), and re-parsing all
   * of it on every tick costs hundreds of milliseconds of CPU several times a
   * minute. Only files whose mtime/size changed are re-read, and files that
   * cannot contain messages inside the history window are skipped entirely.
   */
  interface FileCacheEntry {
    mtimeMs: number;
    size: number;
    messages: ClaudeMessage[];
  }
  const fileCache = new Map<string, FileCacheEntry>();

  /** Files older than this cannot contribute to the 7-day window */
  const HISTORY_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

  /**
   * Collect all messages from all session files across ALL projects
   */
  async function updateMetrics() {
    try {
      const timestamp = new Date().toLocaleTimeString();
      outputChannel.appendLine('');
      outputChannel.appendLine(`[${timestamp}] ========== UPDATE METRICS ==========`);

      const allMessages: ClaudeMessage[] = [];
      let filesParsed = 0;
      let filesCached = 0;
      let filesSkipped = 0;

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
            const stat = fs.statSync(filePath);

            // A file untouched for over a week cannot hold messages we still care
            // about - skip it without opening it.
            if (Date.now() - stat.mtimeMs > HISTORY_WINDOW_MS) {
              fileCache.delete(filePath);
              filesSkipped++;
              continue;
            }

            const cached = fileCache.get(filePath);
            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
              allMessages.push(...cached.messages);
              filesCached++;
              continue;
            }

            const messages = await parseSessionFile(filePath, projectDir);
            fileCache.set(filePath, {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              messages,
            });
            allMessages.push(...messages);
            filesParsed++;
          } catch (err) {
            // Skip files that can't be parsed
            console.warn(`Skipping ${filePath}:`, err);
          }
        }
      }

      outputChannel.appendLine(
        `Collected ${allMessages.length} messages ` +
          `(parsed ${filesParsed} file(s), ${filesCached} from cache, ${filesSkipped} skipped as stale)`
      );

      if (allMessages.length === 0) {
        outputChannel.appendLine('WARNING: No messages found');
        currentSession = null;
        statusBar.update(null, planConfig);
        return;
      }

      // Step 2: Read the authoritative rate limits, if the bridge is feeding us
      const rateLimits = readRateLimits();
      const bridgeActive = getBridgeStatus().active;
      const rateLimitsStatus: 'off' | 'waiting' | 'live' = !bridgeActive
        ? 'off'
        : rateLimits
          ? 'live'
          : 'waiting';
      // Step 3: Calculate metrics (pass output channel for detailed logging)
      outputChannel.appendLine('Calculating session metrics...');
      const metrics = calculateSessionMetrics(
        allMessages,
        'combined',
        planConfig,
        outputChannel,
        rateLimits,
        rateLimitsStatus
      );

      if (metrics && metrics.isActive) {
        outputChannel.appendLine('');
        outputChannel.appendLine('ACTIVE SESSION FOUND:');
        outputChannel.appendLine(`  Started: ${metrics.startTime.toLocaleString()}`);
        outputChannel.appendLine(`  Last activity: ${metrics.lastMessageTime.toLocaleString()}`);
        const vsBudget = (value: number, budget?: number, digits = 0) => {
          const shown = value.toFixed(digits);
          if (!budget || budget <= 0) {
            return `${shown} (no budget set)`;
          }
          return `${shown} / ${budget.toFixed(digits)} (${((value / budget) * 100).toFixed(1)}%)`;
        };

        outputChannel.appendLine(`  Tokens: ${vsBudget(metrics.totalTokens, planConfig.tokenLimit)}`);
        outputChannel.appendLine(`  Cost: $${vsBudget(metrics.totalCost, metrics.costLimit, 2)}`);
        outputChannel.appendLine(`  Messages: ${vsBudget(metrics.messageCount, metrics.messageLimit)}`);
        if (metrics.rateLimits?.fiveHour) {
          outputChannel.appendLine(
            `  5h limit (real): ${metrics.rateLimits.fiveHour.usedPercent.toFixed(1)}%`
          );
        }
        if (metrics.rateLimits?.sevenDay) {
          outputChannel.appendLine(
            `  7d limit (real): ${metrics.rateLimits.sevenDay.usedPercent.toFixed(1)}%`
          );
        }

        currentSession = metrics;
        statusBar.update(currentSession, planConfig);
        statusBar.updateTooltip(currentSession, planConfig);

        // Update popup panel if open
        if (popupPanel.isOpen()) {
          popupPanel.update(currentSession, planConfig);
        }
      } else {
        outputChannel.appendLine('WARNING: No active sessions');

        currentSession = null;
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
    const now = new Date();

    if (currentSession && currentSession.isActive) {
      // Detect stale session data, e.g. after laptop sleep/resume.
      //
      // NOTE: this deliberately does not compare calendar days. A 5-hour window
      // legitimately spans midnight, so a "started on a different day" check would
      // flag every such session as stale and clear the display once a second.
      // Expiry is the actual staleness signal.
      const sessionExpired = now > currentSession.sessionEndTime;

      if (sessionExpired) {
        outputChannel.appendLine(
          `[Timer] Session expired at ${currentSession.sessionEndTime.toLocaleString()} - forcing refresh`
        );

        // Clear current session and trigger metrics update
        currentSession = null;
        statusBar.update(null, planConfig);
        if (popupPanel.isOpen()) {
          popupPanel.showNoSession();
        }

        // Trigger immediate metrics update
        setTimeout(() => updateMetrics(), 100);
        return; // Don't update with stale data
      }

      // Recalculate timeRemaining dynamically for live countdown
      const timeRemaining = Math.max(0, currentSession.sessionEndTime.getTime() - now.getTime());
      const updatedSession = {
        ...currentSession,
        timeRemaining,
      };

      // If timer reached 0, session has ended
      if (timeRemaining === 0) {
        outputChannel.appendLine(`[Timer] Session ended at ${now.toLocaleTimeString()}`);

        // Show notification if enabled
        const config = vscode.workspace.getConfiguration('claudeStatusBar');
        const notifyOnSessionEnded = config.get<boolean>(
          'notifications.sessionEnded',
          true
        );

        if (notifyOnSessionEnded) {
          vscode.window.showInformationMessage(
            '🔄 Claude session ended\nStart a new conversation to begin tracking.',
            'OK'
          );
        }

        // Clear session and show "No Session"
        currentSession = null;
        statusBar.update(null, planConfig);
        if (popupPanel.isOpen()) {
          popupPanel.showNoSession();
        }

        // Trigger immediate metrics update to check for new session
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

  // Register commands
  const showDetails = vscode.commands.registerCommand(
    'claude-statusbar.showDetails',
    () => {
      popupPanel.show(currentSession, planConfig);
    }
  );

  /**
   * Ask for the three budgets in one flow. Leaving a field empty (or entering 0)
   * clears that budget, which is a supported state - the metric is then shown as
   * a measured value with no percentage.
   */
  const setBudgets = vscode.commands.registerCommand(
    'claude-statusbar.setBudgets',
    async () => {
      const config = vscode.workspace.getConfiguration('claudeStatusBar');

      const ask = async (
        key: string,
        prompt: string,
        placeHolder: string
      ): Promise<boolean> => {
        const current = userValue<number>(config, key);
        const input = await vscode.window.showInputBox({
          prompt: `${prompt} (empty or 0 = no budget)`,
          placeHolder,
          value: current !== undefined ? String(current) : '',
          validateInput: (value) => {
            if (value.trim() === '') {
              return null;
            }
            const num = Number(value);
            return Number.isFinite(num) && num >= 0 ? null : 'Enter a number, or leave empty';
          },
        });

        if (input === undefined) {
          return false; // cancelled - leave everything untouched
        }

        const parsed = input.trim() === '' ? 0 : Number(input);
        await config.update(key, parsed, vscode.ConfigurationTarget.Global);
        return true;
      };

      if (!(await ask('tokenBudget', 'Token budget for the 5-hour window', '200000'))) { return; }
      if (!(await ask('costBudget', 'Cost budget in USD', '50'))) { return; }
      if (!(await ask('messageBudget', 'Message budget', '500'))) { return; }

      planConfig = loadPlanConfig();
      statusBar.update(currentSession, planConfig);
      if (popupPanel.isOpen()) {
        popupPanel.update(currentSession, planConfig);
      }

      const set = [
        planConfig.tokenLimit ? `${planConfig.tokenLimit.toLocaleString()} tokens` : null,
        planConfig.costLimit ? `$${planConfig.costLimit.toFixed(2)}` : null,
        planConfig.messageLimit ? `${planConfig.messageLimit} messages` : null,
      ].filter(Boolean);

      vscode.window.showInformationMessage(
        set.length ? `Budgets set: ${set.join(', ')}` : 'Budgets cleared - values shown without a target'
      );
    }
  );

  /**
   * Retired in 0.5.0. Plans carried budgets that were never real quotas, so the
   * plan setting is gone. The command IDs stay registered - they are not in the
   * palette any more, but an existing keybinding must not break with "command not
   * found"; it explains the change and offers the replacement instead.
   */
  const retiredPlanCommands = [
    'claude-statusbar.setPlanPro',
    'claude-statusbar.setPlanMax5',
    'claude-statusbar.setPlanMax20',
    'claude-statusbar.setPlanCustom',
  ].map((id) =>
    vscode.commands.registerCommand(id, async () => {
      const choice = await vscode.window.showInformationMessage(
        'Plan presets were removed: they carried token limits Anthropic never published. ' +
          'Set your own budgets instead, or enable the real usage limits reported by Claude Code.',
        'Set Budgets',
        'Enable Real Usage Limits'
      );
      if (choice === 'Set Budgets') {
        vscode.commands.executeCommand('claude-statusbar.setBudgets');
      } else if (choice === 'Enable Real Usage Limits') {
        vscode.commands.executeCommand('claude-statusbar.enableRealLimits');
      }
    })
  );

  const refresh = vscode.commands.registerCommand('claude-statusbar.refresh', () => {
    updateMetrics();
  });

  /**
   * Install the status line bridge, which is the only way to obtain the real
   * 5-hour / 7-day usage percentages (no hook exposes them, and they are absent
   * from the transcript files).
   */
  const enableRealLimits = vscode.commands.registerCommand(
    'claude-statusbar.enableRealLimits',
    async () => {
      const status = getBridgeStatus();

      if (status.active) {
        vscode.window.showInformationMessage(
          'Real usage limits are already enabled. Send a message in Claude Code to refresh the data.'
        );
        return;
      }

      if (!(await checkNodeAvailable())) {
        vscode.window.showErrorMessage(
          'Node.js was not found on PATH. The Claude Code status line bridge needs `node` to run.'
        );
        return;
      }

      const existingStatusLine = readExistingStatusLineCommand();
      const detail = existingStatusLine
        ? `This writes a script to ${getClaudeConfigDir()} and points Claude Code's statusLine at it. ` +
          `Your current status line will keep working (it will be called by the bridge) and is restored on disable.`
        : `This writes a script to ${getClaudeConfigDir()} and sets Claude Code's statusLine to it, ` +
          `so the extension can read the real 5-hour and weekly usage percentages.`;

      const choice = await vscode.window.showInformationMessage(
        'Enable real usage limits?',
        { modal: true, detail },
        'Enable'
      );

      if (choice !== 'Enable') {
        return;
      }

      try {
        installBridge();
        outputChannel.appendLine(`[Bridge] Installed into ${getClaudeConfigDir()}`);
        vscode.window.showInformationMessage(
          'Real usage limits enabled. Send a message in Claude Code to populate the data.'
        );
        updateMetrics();
      } catch (err) {
        outputChannel.appendLine(`[Bridge] Install failed: ${err}`);
        vscode.window.showErrorMessage(`Could not enable real usage limits: ${err}`);
      }
    }
  );

  const disableRealLimits = vscode.commands.registerCommand(
    'claude-statusbar.disableRealLimits',
    async () => {
      try {
        uninstallBridge();
        outputChannel.appendLine('[Bridge] Uninstalled, previous status line restored');
        vscode.window.showInformationMessage(
          'Real usage limits disabled and the previous Claude Code status line restored.'
        );
        updateMetrics();
      } catch (err) {
        vscode.window.showErrorMessage(`Could not disable real usage limits: ${err}`);
      }
    }
  );

  const showBridgeStatus = vscode.commands.registerCommand(
    'claude-statusbar.showLimitsStatus',
    () => {
      const status = getBridgeStatus();
      const snapshot = readRateLimits();

      const lines = [
        `Claude config dir: ${status.claudeDir}`,
        `Bridge script installed: ${status.installed ? 'yes' : 'no'}`,
        `Wired into settings.json: ${status.active ? 'yes' : 'no'}`,
        `Delegating to your status line: ${status.delegate ?? 'none'}`,
        snapshot
          ? `Last snapshot: ${snapshot.updatedAt.toLocaleString()}`
          : 'Last snapshot: none (send a message in Claude Code)',
        snapshot?.fiveHour
          ? `5-hour: ${snapshot.fiveHour.usedPercent.toFixed(1)}% used, resets ${snapshot.fiveHour.resetsAt.toLocaleString()}`
          : '5-hour: not reported',
        snapshot?.sevenDay
          ? `7-day: ${snapshot.sevenDay.usedPercent.toFixed(1)}% used, resets ${snapshot.sevenDay.resetsAt.toLocaleString()}`
          : '7-day: not reported',
      ];

      outputChannel.appendLine('');
      outputChannel.appendLine('===== USAGE LIMITS BRIDGE STATUS =====');
      lines.forEach((l) => outputChannel.appendLine(l));
      outputChannel.show(true);
    }
  );

  context.subscriptions.push(
    statusBar,
    popupPanel,
    showDetails,
    setBudgets,
    ...retiredPlanCommands,
    refresh,
    enableRealLimits,
    disableRealLimits,
    showBridgeStatus,
    outputChannel
  );

  // Watch the bridge snapshot so real limits refresh the moment Claude Code
  // renders its status line, without waiting for the polling interval.
  const rateLimitWatcher = chokidar.watch(getRateLimitFilePath(), {
    persistent: true,
    ignoreInitial: true,
  });
  rateLimitWatcher.on('add', () => updateMetrics());
  rateLimitWatcher.on('change', () => updateMetrics());
  context.subscriptions.push({ dispose: () => rateLimitWatcher.close() });

  // Carry budgets written by an earlier version onto the current setting keys
  migrateLegacySettings(context).then(() => {
    planConfig = loadPlanConfig();
    statusBar.update(currentSession, planConfig);
  });

  // One-time, non-blocking nudge: the real numbers are a command away
  maybeSuggestBridge(context);
}

/** Read whatever statusLine command Claude Code currently uses, if any */
function readExistingStatusLineCommand(): string | undefined {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(getClaudeConfigDir(), 'settings.json'), 'utf8')
    );
    const command = settings?.statusLine?.command;
    return typeof command === 'string' ? command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Suggest enabling the bridge once. Local token/cost figures are estimates; the
 * real quota percentages only become available through the status line.
 */
async function maybeSuggestBridge(context: vscode.ExtensionContext) {
  const SUGGESTED_KEY = 'claudeStatusBar.bridgeSuggested';

  if (context.globalState.get<boolean>(SUGGESTED_KEY)) {
    return;
  }
  if (getBridgeStatus().active) {
    return;
  }

  await context.globalState.update(SUGGESTED_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    'Claude Status Bar can read your real 5-hour and weekly usage limits from Claude Code instead of estimating them.',
    'Enable',
    'Not now'
  );

  if (choice === 'Enable') {
    vscode.commands.executeCommand('claude-statusbar.enableRealLimits');
  }
}

/**
 * Load plan configuration from VS Code settings
 */
/**
 * Settings renamed in 0.5.0. The old keys are still read as a fallback, so a
 * configuration written by an earlier version keeps working even if the one-time
 * migration never ran (fresh machine, synced settings, manual edit).
 */
const LEGACY_SETTING_KEYS: Record<string, string> = {
  tokenBudget: 'customTokenLimit',
  costBudget: 'customCostLimit',
  messageBudget: 'customMessageLimit',
};

/** Value the user actually set, ignoring the packaged default */
function userValue<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const info = config.inspect<T>(key);
  return info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
}

function loadPlanConfig(): PlanConfig {
  const config = vscode.workspace.getConfiguration('claudeStatusBar');

  const budget = (key: string): number | undefined =>
    userValue<number>(config, key) ?? userValue<number>(config, LEGACY_SETTING_KEYS[key]);

  return getPlanConfig({
    tokenLimit: budget('tokenBudget'),
    costLimit: budget('costBudget'),
    messageLimit: budget('messageBudget'),
  });
}

/**
 * Copy budgets written by an earlier version onto the current keys, once.
 *
 * Only values the user explicitly set are carried over. The old per-plan presets
 * (19k/88k/220k tokens) are deliberately NOT restored: they were never real
 * quotas, and reinstating them would bring back percentages like "525%".
 */
async function migrateLegacySettings(context: vscode.ExtensionContext) {
  const MIGRATED_KEY = 'claudeStatusBar.settingsMigrated.0.5.0';
  if (context.globalState.get<boolean>(MIGRATED_KEY)) {
    return;
  }

  const config = vscode.workspace.getConfiguration('claudeStatusBar');
  const migrated: string[] = [];

  for (const [current, legacy] of Object.entries(LEGACY_SETTING_KEYS)) {
    const legacyValue = userValue<number>(config, legacy);
    if (legacyValue === undefined || userValue<number>(config, current) !== undefined) {
      continue;
    }
    try {
      await config.update(current, legacyValue, vscode.ConfigurationTarget.Global);
      migrated.push(`${legacy} -> ${current} (${legacyValue})`);
    } catch {
      // Settings file not writable - the fallback read above still covers us
    }
  }

  await context.globalState.update(MIGRATED_KEY, true);

  if (migrated.length) {
    console.log(`[Claude Status Bar] Migrated settings: ${migrated.join(', ')}`);
  }
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
