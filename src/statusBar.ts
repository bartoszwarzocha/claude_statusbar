import * as vscode from 'vscode';
import { SessionMetrics, PlanConfig } from './types';
import { formatTimeRemaining } from './sessionCalculator';
import { formatCost } from './pricing';
import { budgetPercent } from './plans';
import { clampPercent, displayPercent } from './percentage';

/**
 * Manages the status bar item showing session information.
 *
 * Two display modes:
 *  - Bridge active (real data from Claude Code):
 *      Reset: HH:MM:SS | Ctx: 42% | 5h: 23% | 7d: 41% | C: $12.56
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

    const config = vscode.workspace.getConfiguration('claudeStatusBar');
    const showContext = config.get<boolean>('showContextInStatusBar', false);
    const showContextAsCircle = config.get<boolean>('showContextAsCircle', false);
    const contextStatus = showContext
      ? formatContextStatus(session.sessionContexts, showContextAsCircle)
      : undefined;

    if (contextStatus && !showContextAsCircle) {
      parts.push(`Ctx: ${contextStatus}`);
    }

    const fiveHour = session.rateLimits?.fiveHour;
    const sevenDay = session.rateLimits?.sevenDay;

    // While Claude Code is being asked for the first time the slots are held
    // open with an ellipsis, so the numbers arriving a minute later do not look
    // like something that was missing
    const loading = !fiveHour && !sevenDay && session.rateLimitsStatus === 'loading';

    if (fiveHour) {
      parts.push(`5h: ${displayPercent(fiveHour.usedPercent).toFixed(0)}%`);
    }
    if (sevenDay) {
      parts.push(`7d: ${displayPercent(sevenDay.usedPercent).toFixed(0)}%`);
    }
    if (loading) {
      parts.push('5h: …', '7d: …');
    }

    // Cost is always shown - it is computed from real token counts and prices
    const costPercent = budgetPercent(session.totalCost, session.costLimit);
    const displayedCostPercent = costPercent === undefined ? undefined : displayPercent(costPercent);
    parts.push(
      costPercent === undefined
        ? `C: ${formatCost(session.totalCost)}`
        : `C: ${formatCost(session.totalCost)}/${formatCost(session.costLimit!)}`
    );

    // Without real rate limit data, fall back to token/message counters
    if (!fiveHour && !sevenDay && !loading) {
      const tokenPercent = budgetPercent(session.totalTokens, planConfig.tokenLimit);
      const displayedTokenPercent = tokenPercent === undefined ? undefined : displayPercent(tokenPercent);
      parts.push(
        tokenPercent === undefined
          ? `T: ${formatCompact(session.totalTokens)}`
          : `T: ${displayedTokenPercent!.toFixed(1)}%`
      );

      const messagePercent = budgetPercent(session.messageCount, session.messageLimit);
      const displayedMessagePercent = messagePercent === undefined ? undefined : displayPercent(messagePercent);
      parts.push(
        messagePercent === undefined
          ? `M: ${session.messageCount}`
          : `M: ${displayedMessagePercent!.toFixed(1)}%`
      );
    }

    const icon = showContextAsCircle && contextStatus
      ? contextStatus
      : '$(claude-icon)  ';
    this.statusBarItem.text = `${icon}${parts.join(' | ')}`;

    // Colour on consumed usage, regardless of whether context is displayed as used or available.
    const contextPercent = session.sessionContexts[0]?.contextPercent;
    const severityPercent = Math.max(
      fiveHour?.usedPercent ?? -1,
      sevenDay?.usedPercent ?? -1,
      showContext && contextPercent !== undefined ? clampPercent(contextPercent) : -1,
      !fiveHour && !sevenDay && (!showContext || contextPercent === undefined)
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

    const currentContext = session.sessionContexts[0];
    if (currentContext?.contextPercent !== undefined && Number.isFinite(currentContext.contextPercent)) {
      const used = displayPercent(currentContext.contextPercent, false);
      const marker = currentContext.estimated ? '~' : '';
      lines.push(
        currentContext.title
          ? `**Current context** (${currentContext.label})\n- ${currentContext.title}: ${marker}${used.toFixed(1)}% used, ${marker}${(100 - used).toFixed(1)}% remaining`
          : `**Current context** (${currentContext.label})\n- ${marker}${used.toFixed(1)}% used, ${marker}${(100 - used).toFixed(1)}% available`,
        currentContext.contextTokens !== undefined && currentContext.contextWindowSize !== undefined
          ? `- ${currentContext.contextTokens.toLocaleString()} / ${currentContext.contextWindowSize.toLocaleString()} tokens in context`
          : '',
        ''
      );
    }

    const fiveHour = session.rateLimits?.fiveHour;
    const sevenDay = session.rateLimits?.sevenDay;

    if (fiveHour || sevenDay) {
      // Claude Code is asked every two minutes; if it has stopped answering,
      // date the reading rather than let a frozen percentage pass for a live one.
      const updatedAt = session.rateLimits?.updatedAt;
      const age = updatedAt ? Date.now() - updatedAt.getTime() : 0;
      const asOf = updatedAt && age >= 5 * 60 * 1000 ? ` as of ${updatedAt.toLocaleTimeString()}` : '';
      lines.push(`**Usage limits** _(reported by Claude Code${asOf})_`);
      if (fiveHour) {
        lines.push(
          `- 5-hour: ${fiveHour.usedPercent.toFixed(1)}% used, ${(100 - fiveHour.usedPercent).toFixed(1)}% remaining, resets ${fiveHour.resetsAt.toLocaleTimeString()}`
        );
      }
      if (sevenDay) {
        lines.push(
          `- 7-day: ${sevenDay.usedPercent.toFixed(1)}% used, ${(100 - sevenDay.usedPercent).toFixed(1)}% remaining, resets ${sevenDay.resetsAt.toLocaleString()}`
        );
      }
      if (asOf && session.rateLimitsNote) {
        lines.push(`- _Newer numbers are unavailable: ${session.rateLimitsNote}_`);
      }
      lines.push('');
    } else {
      lines.push('**Usage limits**', `- ${limitsStateText(session)}`, '');
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

/** Format the newest session context for the status bar. */
export function formatContextStatus(
  contexts: SessionMetrics['sessionContexts'],
  showCircle = false
): string | undefined {
  const context = contexts[0];
  if (!context || context.contextPercent === undefined || !Number.isFinite(context.contextPercent)) {
    return undefined;
  }

  const used = displayPercent(context.contextPercent, false);
  const displayed = displayPercent(context.contextPercent);
  const circlePercent = Math.round(used / 5) * 5;
  return showCircle ? `$(claude-context-${circlePercent})` : `${displayed.toFixed(0)}%`;
}


/** Why there are no 5-hour / weekly figures, in one line */
function limitsStateText(session: SessionMetrics): string {
  switch (session.rateLimitsStatus) {
    case 'loading':
      return 'Reading your 5-hour and weekly usage from Claude Code… The first read can take up to a minute.';
    case 'waiting':
      return (
        '5-hour and weekly limits exist only on a Claude Pro or Max subscription; Claude Code reports none for ' +
        'this sign-in (API key, Bedrock or Google Cloud are billed per token).' +
        (session.rateLimitsNote ? ` Claude Code says: “${session.rateLimitsNote}”` : '')
      );
    case 'error':
      return `Could not read the usage limits. ${session.rateLimitsNote ?? ''} Retrying automatically.`;
    case 'off':
      return 'Claude Code was not found on this computer (neither the VS Code extension nor the CLI).';
    default:
      return 'Not reported';
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
