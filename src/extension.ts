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
   * Collect all messages from all session files across ALL projects
   */
  async function updateMetrics() {
    try {
      console.log('🔄 Updating metrics...');

      const allMessages: any[] = [];

      // Step 1: Collect ALL messages from ALL files across ALL projects
      for (const basePath of claudeDataPaths) {
        if (!fs.existsSync(basePath)) {
          continue;
        }

        const projectDirs = fs.readdirSync(basePath);

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
              const messages = await parseSessionFile(filePath);
              allMessages.push(...messages);
            } catch (err) {
              // Skip files that can't be parsed
              console.warn(`Skipping ${filePath}:`, err);
            }
          }
        }
      }

      console.log(`📊 Collected ${allMessages.length} total messages`);

      if (allMessages.length === 0) {
        console.log('   └─ ⚠️ No messages found');
        currentSession = null;
        statusBar.update(null, planConfig);
        return;
      }

      // Step 2: Calculate metrics
      const metrics = calculateSessionMetrics(allMessages, 'combined', planConfig);

      if (metrics && metrics.isActive) {
        console.log(`✅ Active session found`);
        console.log(`   └─ Started: ${metrics.startTime.toLocaleString()}`);
        console.log(`   └─ Last activity: ${metrics.lastMessageTime.toLocaleString()}`);
        console.log(`   └─ Tokens: ${metrics.totalTokens}`);
        console.log(`   └─ Cost: $${metrics.totalCost.toFixed(2)}`);
        console.log(`   └─ Messages: ${metrics.messageCount}`);

        currentSession = metrics;
        statusBar.update(currentSession, planConfig);
      } else {
        console.log('   └─ ⚠️ No active sessions');
        currentSession = null;
        statusBar.update(null, planConfig);
      }
    } catch (error) {
      console.error('❌ Error updating metrics:', error);
    }
  }

  // Update immediately
  updateMetrics();

  // Get refresh interval from settings (1-60 seconds)
  const config = vscode.workspace.getConfiguration('claudeStatusBar');
  const refreshInterval = Math.max(1, Math.min(60, config.get<number>('refreshInterval', 5)));

  // Update at configured interval
  const interval = setInterval(updateMetrics, refreshInterval * 1000);

  context.subscriptions.push({
    dispose: () => clearInterval(interval),
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
    refresh
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
