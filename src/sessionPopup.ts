import * as vscode from 'vscode';
import { SessionMetrics, PlanConfig, RateLimitWindow, SessionContextInfo } from './types';
import { formatTimeRemaining, getStatusColor } from './sessionCalculator';
import { formatCost } from './pricing';
import { budgetPercent } from './plans';

/**
 * Render "23.5%", or nothing at all when there is no budget to measure against.
 * An empty string is deliberate: a placeholder character next to a bar that can
 * never fill just adds noise.
 */
function formatPercent(percent: number | undefined): string {
  return percent === undefined ? '' : `${percent.toFixed(1)}%`;
}

/**
 * A progress bar with no target is dead weight - it renders as an empty track.
 * Hide it and let the value in the label speak for itself.
 */
function barVisibility(percent: number | undefined): string {
  return percent === undefined ? ' style="display: none;"' : '';
}

/** Collapses the vertical space the hidden bar would have occupied */
function containerClass(percent: number | undefined): string {
  return percent === undefined ? ' no-bar' : '';
}

/** One slice of a composition bar */
interface CompositionSegment {
  name: string;
  value: number;
  color: string;
}

/**
 * Shades per model family. A composition bar can hold several models of the same
 * family - Opus 5 next to Opus 4.8 - and colouring by family alone made those
 * neighbouring segments identical and impossible to tell apart. The family keeps
 * its hue for recognisability; each model within it takes the next shade.
 */
const TIER_SHADES: Record<string, string[]> = {
  fable: ['#c084fc', '#5b21b6', '#e9d5ff', '#8b5cf6'],
  opus: ['#ff6b6b', '#a51111', '#ffc9c9', '#e03131'],
  sonnet: ['#4dabf7', '#0b4a8f', '#a5d8ff', '#1c7ed6'],
  haiku: ['#51cf66', '#1a6b2a', '#b2f2bb', '#2f9e44'],
  unknown: ['#868e96', '#343a40', '#ced4da', '#5c636a'],
};

/** Base colour of a family, used where only one entry per family can appear */
const TIER_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(TIER_SHADES).map(([tier, shades]) => [tier, shades[0]])
);

function tierShade(tier: string, indexWithinTier: number): string {
  const shades = TIER_SHADES[tier] || TIER_SHADES.unknown;
  return shades[indexWithinTier % shades.length];
}

function hashHue(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = label.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Stable colours for arbitrary labels (project names), nudged apart when two of
 * them hash to nearly the same hue - otherwise neighbouring segments blend into
 * one another. Mirrors projectColors() in the webview.
 */
function projectColors(labels: string[]): string[] {
  const hues: number[] = [];
  for (const label of labels) {
    let hue = hashHue(label);
    let guard = 0;
    while (hues.some((h) => hueDistance(h, hue) < 30) && guard < 12) {
      hue = (hue + 47) % 360;
      guard++;
    }
    hues.push(hue);
  }
  return hues.map((h) => `hsl(${h}, 65%, 55%)`);
}

/** "claude-opus-4-8" -> "Opus 4.8", "claude-haiku-4-5-20251001" -> "Haiku 4.5" */
function prettyModelName(id: string): string {
  const parts = id.replace(/^claude-/, '').split('-');
  const family = parts.shift() || id;
  const version = parts.filter((p) => /^\d+$/.test(p) && p.length <= 2).join('.');
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${label} ${version}` : label;
}

/**
 * Build the segments for each metric's composition bar.
 *
 * These show what the value is MADE OF rather than how close it is to a limit,
 * so the slot stays informative when no budget is configured - without inventing
 * a denominator.
 */
export function tokenSegments(session: SessionMetrics): CompositionSegment[] {
  const order: Array<[string, string]> = [
    ['fable', 'Fable'],
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['haiku', 'Haiku'],
    ['unknown', 'Other'],
  ];
  return order
    .map(([tier, name]) => ({
      name,
      value: session.modelBreakdown[tier as keyof typeof session.modelBreakdown] || 0,
      color: TIER_COLORS[tier],
    }))
    .filter((s) => s.value > 0);
}

function tierOf(id: string): string {
  if (id.includes('fable') || id.includes('mythos')) {
    return 'fable';
  }
  if (id.includes('opus')) {
    return 'opus';
  }
  if (id.includes('haiku')) {
    return 'haiku';
  }
  if (id.includes('sonnet')) {
    return 'sonnet';
  }
  return 'unknown';
}

export function costSegments(session: SessionMetrics): CompositionSegment[] {
  const seenPerTier: Record<string, number> = {};
  return Object.entries(session.costByModel || {})
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, cost]) => {
      const tier = tierOf(id);
      const index = seenPerTier[tier] || 0;
      seenPerTier[tier] = index + 1;
      return { name: prettyModelName(id), value: cost, color: tierShade(tier, index) };
    });
}

export function messageSegments(session: SessionMetrics): CompositionSegment[] {
  const entries = Object.entries(session.messagesByProject || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const colors = projectColors(entries.map(([project]) => project));
  return entries.map(([project, count], i) => ({ name: project, value: count, color: colors[i] }));
}

/**
 * Render a composition bar plus its legend. Occupies the same slot and height as
 * a progress bar, so sections look consistent whether or not a budget is set.
 */
function renderCompositionBar(id: string, segments: CompositionSegment[]): string {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) {
    return '';
  }

  const slices = segments
    .map((s) => {
      const pct = (s.value / total) * 100;
      return `<div class="stacked-segment" style="width: ${pct.toFixed(2)}%; background-color: ${s.color};" title="${escapeHtml(s.name)}">${pct >= 12 ? `${pct.toFixed(0)}%` : ''}</div>`;
    })
    .join('');

  const legend = segments
    .map(
      (s) =>
        `<span><span class="comp-dot" style="background-color: ${s.color};"></span>${escapeHtml(s.name)} ${((s.value / total) * 100).toFixed(0)}%</span>`
    )
    .join('');

  return `
            <div class="stacked-bar" id="${id}-composition">${slices}</div>
            <div class="comp-legend" id="${id}-composition-legend">${legend}</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One usage tile: a large threshold-coloured percentage, a caption, and a thin
 * bar so "how much is left" is still readable at a glance.
 *
 * `percent` is undefined when the value is not reported - the tile stays in place
 * with a dash so the three-column grid does not collapse.
 */
function renderLimitTile(
  id: string,
  label: string,
  percent: number | undefined,
  sub: string,
  /** Prefixes the value with ~ - the number is ours, not Claude Code's */
  approximate = false
): string {
  const known = percent !== undefined;
  const color = known ? getStatusColor(percent) : 'var(--vscode-descriptionForeground)';
  const value = known ? `${approximate ? '~' : ''}${Math.round(percent)}%` : '—';
  const width = known ? Math.min(percent, 100) : 0;

  return `
            <div class="limit-tile">
                <div class="limit-tile-label">${label}</div>
                <div class="limit-tile-value" id="${id}-value" style="color: ${color};">${value}</div>
                <div class="limit-tile-sub" id="${id}-sub">${sub}</div>
                <div class="limit-tile-bar">
                    <div class="limit-tile-fill" id="${id}-fill" style="width: ${width}%; background-color: ${known ? color : 'transparent'};"></div>
                </div>
            </div>`;
}

/** Short caption under a window tile: when it resets */
function resetCaption(window: RateLimitWindow | undefined, withDate: boolean): string {
  if (!window) {
    return 'not reported';
  }
  const time = window.resetsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return withDate
    ? `resets ${window.resetsAt.toLocaleDateString()} ${time}`
    : `resets ${time}`;
}

/** "3 min ago" / "2 h ago" - how fresh a session's reported context is */
function ageLabel(updatedAt: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 60000));
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return `${Math.floor(minutes / 60)} h ago`;
}

/**
 * One row per Claude Code session.
 *
 * The context window belongs to a conversation, not to the account, so with
 * several sessions open a single number would be meaningless. Each row carries
 * its own value and how old the reading is, since an idle session stops moving.
 *
 * A `~` marks a value the extension computed from the transcript rather than
 * one Claude Code reported. Sessions running in the VS Code extension are always
 * in that state: it renders no status line, so nothing feeds the bridge.
 */
function renderSessionContexts(session: SessionMetrics): string {
  const rows = session.sessionContexts || [];
  if (rows.length === 0) {
    return '';
  }

  const items = rows
    .map((row) => {
      const known = typeof row.contextPercent === 'number';
      const percent = known ? Math.min(row.contextPercent as number, 100) : 0;
      const color = known ? getStatusColor(row.contextPercent as number) : 'transparent';
      const rowId = `sess-${row.sessionId.replace(/[^\w-]/g, '')}`;
      return `
            <div class="session-row">
                <div class="session-row-head">
                    <span class="session-row-name" title="${escapeHtml(sessionTooltip(row))}">${escapeHtml(row.label)}</span>
                    <span class="session-row-meta" id="${rowId}-meta">${percentLabel(row)} · ${ageLabel(row.updatedAt)}</span>
                </div>
                <div class="session-row-bar"><div class="session-row-fill" id="${rowId}-fill" style="width: ${percent}%; background-color: ${color};"></div></div>
            </div>`;
    })
    .join('');

  return `
        <div class="session-list" id="session-list">
            <div class="session-list-title">Context per session (${rows.length})</div>
            ${items}
        </div>`;
}

/** "47%" / "~47%" / "—" */
function percentLabel(row: SessionContextInfo): string {
  if (typeof row.contextPercent !== 'number') {
    return '—';
  }
  return `${row.estimated ? '~' : ''}${Math.round(row.contextPercent)}%`;
}

/** Hover text: the conversation title, plus why a value is only an estimate */
function sessionTooltip(row: SessionContextInfo): string {
  const parts = [row.title || row.sessionId];
  if (row.entrypoint === 'claude-vscode') {
    parts.push('Running in the VS Code extension, which reports no usage to the bridge.');
  }
  if (row.estimated) {
    parts.push('Context estimated from the transcript.');
  }
  return parts.join(' — ');
}

/**
 * Caption under the rotating context tile: whose context is on screen, and
 * where it sits in the rotation so the number is never anonymous.
 */
function contextCaption(rows: SessionContextInfo[], index: number): string {
  const row = rows[index];
  if (!row) {
    return 'current Claude Code session';
  }
  return rows.length > 1 ? `${row.label} · ${index + 1}/${rows.length}` : row.label;
}

/** The three tiles shown once Claude Code reports usage */
function renderLimitTiles(session: SessionMetrics): string {
  const fiveHour = session.rateLimits?.fiveHour;
  const sevenDay = session.rateLimits?.sevenDay;

  // With several sessions open there is no single context value. The tile shows
  // one session at a time and the page cycles through them, so every session is
  // visible without the number silently changing owner.
  const rows = session.sessionContexts || [];
  const first = rows[0];
  const context = first?.contextPercent ?? session.rateLimits?.contextUsedPercent;

  return `
        <div class="limit-tiles">
            ${renderLimitTile('ctx', 'Context', context, contextCaption(rows, 0), Boolean(first?.estimated))}
            ${renderLimitTile('five-hour', '5-hour window', fiveHour?.usedPercent, resetCaption(fiveHour, false))}
            ${renderLimitTile('seven-day', '7-day window', sevenDay?.usedPercent, resetCaption(sevenDay, true))}
        </div>
        ${renderSessionContexts(session)}`;
}

/**
 * The Usage Limits section is always rendered - it is the only authoritative
 * source of "how much of my plan is left", so hiding it would hide the most
 * useful thing here. It has three states:
 *
 *  live    - real percentages are being read
 *  off     - the bridge is not installed; offer to turn it on
 *  waiting - the bridge runs but Claude Code reports no limits, which means an
 *            API key / Bedrock / Vertex login (no such windows exist at all) or
 *            simply no model response yet in this session
 */
function renderLimitsSection(session: SessionMetrics): string {
  const fiveHour = session.rateLimits?.fiveHour;
  const sevenDay = session.rateLimits?.sevenDay;
  const hasSessions = (session.sessionContexts || []).length > 0;

  if (fiveHour || sevenDay) {
    return `
    <div class="section-header">
        <h2>Usage Limits</h2>
        <div class="collapse-toggle" style="cursor: default;">reported by Claude Code${freshnessSuffix(session)}</div>
    </div>
    <div class="metric-section">${renderLimitTiles(session)}${renderStaleWarning(session)}
    </div>`;
  }

  // No windows to show. The tiles still earn their place when at least one
  // session's context is known - that part does not depend on the bridge.
  const caption = session.rateLimitsStatus === 'waiting' ? 'no limits reported' : 'not enabled';
  const hint =
    session.rateLimitsStatus === 'waiting'
      ? `
        <div class="limits-hint">
            <div>
                <div class="limits-hint-title">Claude Code is not reporting any usage limits</div>
                <div class="info-label">These windows exist only on a Claude.ai <strong>Pro</strong> or
                <strong>Max</strong> subscription. If Claude Code signs in with an API key, Amazon Bedrock
                or Google Cloud, usage is billed per token and there is no 5-hour or weekly limit to show —
                the cost figures below are what you want. If you are on Pro or Max and just enabled this,
                send one message in Claude Code and the bars will appear.${vsCodeCaveat(session)}</div>
            </div>
        </div>`
      : `
        <div class="limits-hint">
            <div>
                <div class="limits-hint-title">See how much of your plan you have actually used</div>
                <div class="info-label">Claude Code knows how much of your 5-hour and weekly limits you
                have consumed, and when each one resets. Turning this on lets the extension read those
                numbers and show them here as progress bars. Requires a Claude.ai <strong>Pro</strong> or
                <strong>Max</strong> subscription. One-time setup, undo at any time.</div>
            </div>
            <button class="limits-button" onclick="runCommand('claude-statusbar.enableRealLimits')">Turn on</button>
        </div>`;

  return `
    <div class="section-header">
        <h2>Usage Limits</h2>
        <div class="collapse-toggle" style="cursor: default;">${caption}</div>
    </div>
    <div class="metric-section">${hasSessions ? renderLimitTiles(session) : ''}
        ${hint}
    </div>`;
}

/** Anything older than this is worth putting a date on */
const FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000;

/** Beyond this the percentages describe a window that has moved on without us */
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * The 5-hour and 7-day figures are only as current as the last status line
 * render. Saying so is the difference between "you have used 23%" and "you had
 * used 23% two hours ago", which are very different pieces of advice.
 */
function freshnessSuffix(session: SessionMetrics): string {
  const updatedAt = session.rateLimits?.updatedAt;
  if (!updatedAt || Date.now() - updatedAt.getTime() < FRESHNESS_THRESHOLD_MS) {
    return '';
  }
  return ` · ${ageLabel(updatedAt)}`;
}

/** True while a session is running under the VS Code extension */
function hasVsCodeSession(session: SessionMetrics): boolean {
  return (session.sessionContexts || []).some((row) => row.entrypoint === 'claude-vscode');
}

/**
 * Explain a frozen number rather than let it look live. Claude Code hands the
 * rate limits to status line commands only, and its VS Code extension has no
 * status line, so working there leaves these figures at their last terminal
 * reading until they age out entirely.
 */
function renderStaleWarning(session: SessionMetrics): string {
  const updatedAt = session.rateLimits?.updatedAt;
  if (!updatedAt || Date.now() - updatedAt.getTime() < STALE_THRESHOLD_MS) {
    return '';
  }
  const reason = hasVsCodeSession(session)
    ? `A session is running in the Claude Code <strong>VS Code extension</strong>, which renders no status
       line and therefore reports nothing. Only the terminal (and this panel's own token and cost figures,
       which come from the transcripts) keep moving.`
    : `Claude Code reports these numbers only while a session renders its status line. Send a message in
       the terminal to refresh them.`;
  return `
            <div class="limits-hint">
                <div>
                    <div class="limits-hint-title">These percentages are from ${ageLabel(updatedAt)}</div>
                    <div class="info-label">${reason}</div>
                </div>
            </div>`;
}

/** Appended to the "no limits" hint when the VS Code extension is the reason */
function vsCodeCaveat(session: SessionMetrics): string {
  if (!hasVsCodeSession(session)) {
    return '';
  }
  return ` A session is currently running in the Claude Code <strong>VS Code extension</strong>: it renders
  no status line, so it reports no limits at all. Use the terminal for these windows — tokens, cost and the
  per-session context below are read from the transcripts and work either way.`;
}

/**
 * Manages the detailed popup/webview panel
 */
export class SessionPopupPanel {
  private panel: vscode.WebviewPanel | undefined;
  private extensionUri: vscode.Uri;
  /** Structural variant of the currently rendered page - see layoutKey() */
  private lastLayoutKey: string | undefined;

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

    // Get workspace name
    const workspaceName = this.getWorkspaceName();

    // Check if showProjectName is enabled
    const config = vscode.workspace.getConfiguration('claudeStatusBar');
    const showProjectName = config.get<boolean>('showProjectName', false);

    // Create or show panel
    if (this.panel) {
      this.panel.reveal();
      // Re-render when the page structure changed, otherwise just push data
      const layout = this.layoutKey(session, planConfig);
      if (layout !== this.lastLayoutKey) {
        this.lastLayoutKey = layout;
        this.panel.webview.html = this.getWebviewContent(
          session,
          planConfig,
          workspaceName,
          showProjectName
        );
      } else {
        this.panel.webview.postMessage({
          type: 'update',
          session,
          planConfig,
          workspaceName,
          showProjectName,
        });
      }
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
        this.lastLayoutKey = undefined;
      });

      // Let the panel trigger extension commands (e.g. the Enable button in the
      // Usage Limits section), so the user never has to find the command palette.
      this.panel.webview.onDidReceiveMessage((message) => {
        if (message?.type === 'command' && typeof message.command === 'string') {
          vscode.commands.executeCommand(message.command);
        }
      });

      // Set initial HTML content
      this.lastLayoutKey = this.layoutKey(session, planConfig);
      this.panel.webview.html = this.getWebviewContent(session, planConfig, workspaceName, showProjectName);
    }
  }

  /**
   * Get current workspace name
   */
  private getWorkspaceName(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].name;
    }
    return 'Unknown Workspace';
  }

  /**
   * Update the panel content if it's open (using postMessage instead of full HTML reload)
   */
  public update(session: SessionMetrics | null, planConfig: PlanConfig) {
    if (this.panel && session) {
      // Get workspace name and setting
      const workspaceName = this.getWorkspaceName();
      const config = vscode.workspace.getConfiguration('claudeStatusBar');
      const showProjectName = config.get<boolean>('showProjectName', false);

      // The Usage Limits section is part of the static markup: when it changes
      // shape - the bridge starts reporting, the setting is toggled, the plan
      // changes - postMessage cannot help, because the elements it would target
      // do not exist in the DOM yet. Re-render the page in that case.
      const layout = this.layoutKey(session, planConfig);
      if (layout !== this.lastLayoutKey) {
        this.lastLayoutKey = layout;
        this.panel.webview.html = this.getWebviewContent(
          session,
          planConfig,
          workspaceName,
          showProjectName
        );
        return;
      }

      this.panel.webview.postMessage({
        type: 'update',
        session,
        planConfig,
        workspaceName,
        showProjectName,
      });
    }
  }

  /**
   * Identifies the structural variant of the page. Values that only change text
   * or bar widths are deliberately excluded - those are handled by postMessage.
   */
  private layoutKey(session: SessionMetrics, planConfig: PlanConfig): string {
    const status = session.rateLimitsStatus;
    const hasAnyWindow = Boolean(session.rateLimits?.fiveHour || session.rateLimits?.sevenDay);
    // Whether each metric renders a progress bar or a composition bar is baked
    // into the markup, so a budget appearing or disappearing needs a re-render.
    const sessions = (session.sessionContexts || [])
      .map((c) => c.sessionId)
      .sort()
      .join(',');
    const budgets = [
      Boolean(planConfig.tokenLimit),
      Boolean(session.costLimit),
      Boolean(session.messageLimit),
    ].join(',');
    // The stale-data warning and the VS Code caveat are markup, not values, so
    // they cannot appear through postMessage - crossing either needs a redraw.
    const updatedAt = session.rateLimits?.updatedAt;
    const stale = Boolean(updatedAt && Date.now() - updatedAt.getTime() >= STALE_THRESHOLD_MS);
    return `${status}|${hasAnyWindow}|${budgets}|${sessions}|${stale}|${hasVsCodeSession(session)}`;
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
  private getWebviewContent(session: SessionMetrics, planConfig: PlanConfig, workspaceName: string, showProjectName: boolean): string {
    // Budgets are optional; when unset we show the raw figure with no percentage
    const tokenPercent = budgetPercent(session.totalTokens, planConfig.tokenLimit);
    const costPercent = budgetPercent(session.totalCost, session.costLimit);
    const messagePercent = budgetPercent(session.messageCount, session.messageLimit);

    const tokenColor = getStatusColor(tokenPercent ?? 0);
    const costColor = getStatusColor(costPercent ?? 0);
    const messageColor = getStatusColor(messagePercent ?? 0);

    const timeRemaining = formatTimeRemaining(session.timeRemaining);

    // Calculate time progress percentage
    const totalSessionTime = 5 * 60 * 60 * 1000; // 5 hours
    const elapsedTime = totalSessionTime - session.timeRemaining;
    const timePercent = Math.min((elapsedTime / totalSessionTime) * 100, 100);

    const limitsSection = renderLimitsSection(session);

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
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header-title {
            flex: 1;
        }
        .zoom-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
        }
        .zoom-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            user-select: none;
            font-weight: bold;
            transition: background-color 0.2s;
        }
        .zoom-button:hover:not(.disabled) {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .zoom-button.disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .zoom-percent {
            min-width: 45px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            user-select: none;
            font-size: 13px;
            transition: color 0.2s;
        }
        .zoom-percent:hover {
            color: var(--vscode-textLink-foreground);
        }
        .zoom-percent.default {
            opacity: 0.6;
        }
        .project-name {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
            margin-top: -5px;
            margin-bottom: 15px;
            padding-left: 2px;
        }
        .project-name strong {
            color: var(--vscode-textLink-foreground);
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
        /* No bar to show: collapse the space the bar and its margin occupied,
           otherwise the header appears to float above the content. */
        .progress-container.no-bar {
            margin-bottom: 6px;
        }
        .progress-container.no-bar .progress-label {
            margin-bottom: 0;
        }
        .comp-legend {
            display: flex;
            flex-wrap: wrap;
            gap: 14px;
            margin-top: 6px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .comp-dot {
            display: inline-block;
            width: 9px;
            height: 9px;
            border-radius: 2px;
            margin-right: 5px;
        }
        .limit-tiles {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 10px;
        }
        .limit-tile {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px 14px;
        }
        .limit-tile-label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }
        .limit-tile-value {
            font-size: 30px;
            font-weight: bold;
            line-height: 1.15;
            margin: 4px 0 2px;
        }
        .limit-tile-sub {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .limit-tile-bar {
            height: 6px;
            border-radius: 3px;
            background-color: var(--vscode-input-background);
            overflow: hidden;
            margin-top: 8px;
        }
        .limit-tile-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.3s ease;
        }
        .session-list {
            margin-top: 12px;
        }
        .session-list-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
        }
        .session-row {
            margin-bottom: 7px;
        }
        .session-row-head {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            margin-bottom: 3px;
            gap: 12px;
        }
        .session-row-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .session-row-meta {
            flex-shrink: 0;
            color: var(--vscode-descriptionForeground);
        }
        .session-row-bar {
            height: 4px;
            border-radius: 2px;
            background-color: var(--vscode-input-background);
            overflow: hidden;
        }
        .session-row-fill {
            height: 100%;
            border-radius: 2px;
            transition: width 0.3s ease;
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
        .limits-hint {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
        }
        .limits-hint-title {
            font-weight: 600;
            margin-bottom: 4px;
        }
        .limits-button {
            flex-shrink: 0;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 6px 14px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            cursor: pointer;
        }
        .limits-button:hover {
            background-color: var(--vscode-button-hoverBackground);
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
        const vscodeApi = acquireVsCodeApi();

        // Run an extension command from the panel (used by the Usage Limits button)
        function runCommand(command) {
            vscodeApi.postMessage({ type: 'command', command: command });
        }

        // Zoom functionality
        const MIN_ZOOM = 50;
        const MAX_ZOOM = 150;
        const ZOOM_STEP = 10;
        const DEFAULT_ZOOM = 100;

        let currentZoom = parseInt(localStorage.getItem('claude-popup-zoom')) || DEFAULT_ZOOM;

        function applyZoom(zoom) {
            currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

            // Apply zoom using CSS zoom property (scales entire content)
            document.body.style.zoom = (currentZoom / 100).toString();

            // Update UI
            const percentElem = document.getElementById('zoom-percent');
            const zoomOutBtn = document.getElementById('zoom-out');
            const zoomInBtn = document.getElementById('zoom-in');

            if (percentElem) {
                percentElem.textContent = currentZoom + '%';
                percentElem.classList.toggle('default', currentZoom === DEFAULT_ZOOM);
            }

            if (zoomOutBtn) {
                zoomOutBtn.classList.toggle('disabled', currentZoom <= MIN_ZOOM);
            }

            if (zoomInBtn) {
                zoomInBtn.classList.toggle('disabled', currentZoom >= MAX_ZOOM);
            }

            // Save to localStorage
            localStorage.setItem('claude-popup-zoom', currentZoom.toString());
        }


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

        // Listen for updates from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                const session = message.session;
                const planConfig = message.planConfig;
                const workspaceName = message.workspaceName;
                const showProjectName = message.showProjectName;

                // Update session end time
                sessionEndTime = new Date(session.sessionEndTime).getTime();

                // Reveal the content BEFORE recalculating. If updating a value
                // ever throws, the panel is left showing slightly stale numbers
                // rather than stuck on "No Active Session" until it is reopened.
                document.getElementById('main-content').style.display = 'block';
                document.getElementById('refreshing-message').style.display = 'none';
                document.getElementById('no-session-message').style.display = 'none';

                // Update all metrics
                updateMetrics(session, planConfig);

                // Update project name visibility
                const projectNameElem = document.getElementById('project-name');
                if (projectNameElem) {
                    if (showProjectName && workspaceName) {
                        projectNameElem.innerHTML = 'Project: <strong>' + workspaceName + '</strong>';
                        projectNameElem.style.display = 'block';
                    } else {
                        projectNameElem.style.display = 'none';
                    }
                }

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

        // Percentage against an optional budget; null means "no budget configured"
        function pct(value, budget) {
            if (!budget || budget <= 0) { return null; }
            return (value / budget) * 100;
        }

        function updateMetrics(session, planConfig) {
            const tokenPercent = pct(session.totalTokens, planConfig.tokenLimit);
            const costPercent = pct(session.totalCost, session.costLimit);
            const messagePercent = pct(session.messageCount, session.messageLimit);

            // Update session times (CRITICAL: this fixes stale times after laptop sleep/resume)
            const startTime = new Date(session.startTime).toLocaleString();
            const endTime = new Date(session.sessionEndTime).toLocaleString();
            updateValue('session-times', 'Started: ' + startTime + ' • Ends: ' + endTime);

            // Authoritative usage limits from Claude Code, when available
            updateLimitTiles(session.rateLimits, session.sessionContexts);

            // Token usage
            updateProgress('token', session.totalTokens.toLocaleString(), planConfig.tokenLimit ? planConfig.tokenLimit.toLocaleString() : null, tokenPercent, 'tokens');
            updateValue('input-tokens', session.inputTokens.toLocaleString());
            updateValue('output-tokens', session.outputTokens.toLocaleString());
            updateValue('cache-creation', session.cacheCreationTokens.toLocaleString());
            updateValue('cache-read', session.cacheReadTokens.toLocaleString());
            updateValue('token-burn-rate', Math.round(session.tokenBurnRate) + ' tokens/min');

            // Cost usage - format as currency
            const costCurrent = '$' + session.totalCost.toFixed(2);
            const costLimit = session.costLimit ? '$' + session.costLimit.toFixed(2) : null;
            updateProgress('cost', costCurrent, costLimit, costPercent, '');
            updateValue('cost-burn-rate', '$' + session.costBurnRate.toFixed(4) + '/min');

            // Message count
            updateProgress('message', session.messageCount, session.messageLimit || null, messagePercent, 'messages');
            updateValue('message-burn-rate', session.messageBurnRate.toFixed(1) + ' msg/min');

            // Composition bars fill the slot of any metric that has no budget
            updateComposition('token', tokenCompositionSegments(session));
            updateComposition('cost', costCompositionSegments(session));
            updateComposition('message', messageCompositionSegments(session));

            // Model breakdown
            if (session.modelBreakdown) {
                const modelSegments = [
                    { name: 'Fable', value: session.modelBreakdown.fable, color: MODEL_COLORS.fable },
                    { name: 'Opus', value: session.modelBreakdown.opus, color: MODEL_COLORS.opus },
                    { name: 'Sonnet', value: session.modelBreakdown.sonnet, color: MODEL_COLORS.sonnet },
                    { name: 'Haiku', value: session.modelBreakdown.haiku, color: MODEL_COLORS.haiku },
                    { name: 'Other', value: session.modelBreakdown.unknown, color: MODEL_COLORS.unknown }
                ].filter(s => s.value > 0).map(s => ({
                    ...s,
                    percent: (s.value / session.totalTokens) * 100
                }));

                renderStackedBar('model-stacked-bar', modelSegments);
                renderBreakdownList('model-breakdown-list', modelSegments);
            }

            // Project breakdown
            if (session.projectBreakdown) {
                const projectEntries = Object.entries(session.projectBreakdown)
                    .filter(([name, value]) => value > 0)
                    .sort((a, b) => b[1] - a[1]);
                // Same colour source as the Message Count composition bar, so a
                // project looks the same everywhere in the panel
                const projectPalette = projectColors(projectEntries.map(([name]) => name));
                const projectSegments = projectEntries.map(([name, value], i) => ({
                    name: name,
                    value: value,
                    color: projectPalette[i],
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
                // limit === null means no budget is configured for this metric
                labelElem.innerHTML = limit
                    ? '<strong>' + current + '</strong> / ' + limit + unitStr
                    : '<strong>' + current + '</strong>' + unitStr;
            }
            // No budget -> no percentage and no bar, rather than an empty track
            const percentStr = percent === null ? '' : percent.toFixed(1) + '%';
            if (percentElem) {
                percentElem.innerHTML = percentStr ? '<strong>' + percentStr + '</strong>' : '';
            }
            const barElem = document.getElementById(id + '-bar');
            if (barElem) {
                barElem.style.display = percent === null ? 'none' : '';
            }
            const containerElem = document.getElementById(id + '-container');
            if (containerElem) {
                containerElem.classList.toggle('no-bar', percent === null);
            }
            if (fillElem) {
                fillElem.style.width = Math.min(percent === null ? 0 : percent, 100) + '%';
            }
            if (textElem) {
                textElem.textContent = percentStr;
            }
        }

        // ---- Composition bars (mirror of the server-side renderers) ----

        function updateValue(id, value) {
            const elem = document.getElementById(id);
            if (elem) { elem.textContent = value; }
        }

        function prettyModelName(id) {
            const parts = id.replace(/^claude-/, '').split('-');
            const family = parts.shift() || id;
            const version = parts.filter(p => /^\\d+$/.test(p) && p.length <= 2).join('.');
            const label = family.charAt(0).toUpperCase() + family.slice(1);
            return version ? label + ' ' + version : label;
        }

        function tokenCompositionSegments(session) {
            const b = session.modelBreakdown || {};
            return [
                { name: 'Fable', value: b.fable || 0, color: MODEL_COLORS.fable },
                { name: 'Opus', value: b.opus || 0, color: MODEL_COLORS.opus },
                { name: 'Sonnet', value: b.sonnet || 0, color: MODEL_COLORS.sonnet },
                { name: 'Haiku', value: b.haiku || 0, color: MODEL_COLORS.haiku },
                { name: 'Other', value: b.unknown || 0, color: MODEL_COLORS.unknown }
            ].filter(s => s.value > 0);
        }

        function costCompositionSegments(session) {
            const seen = {};
            return Object.entries(session.costByModel || {})
                .filter(([, cost]) => cost > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([id, cost]) => {
                    const tier = tierOf(id);
                    const i = seen[tier] || 0;
                    seen[tier] = i + 1;
                    return { name: prettyModelName(id), value: cost, color: tierShade(tier, i) };
                });
        }

        function messageCompositionSegments(session) {
            const entries = Object.entries(session.messagesByProject || {})
                .filter(([, count]) => count > 0)
                .sort((a, b) => b[1] - a[1]);
            const colors = projectColors(entries.map(([project]) => project));
            return entries.map(([project, count], i) => ({ name: project, value: count, color: colors[i] }));
        }

        function updateComposition(id, segments) {
            const bar = document.getElementById(id + '-composition');
            const legend = document.getElementById(id + '-composition-legend');
            if (!bar || !legend) { return; }

            const total = segments.reduce((sum, s) => sum + s.value, 0);
            if (total <= 0) { return; }

            bar.innerHTML = segments.map(s => {
                const pct = (s.value / total) * 100;
                const label = pct >= 12 ? pct.toFixed(0) + '%' : '';
                return '<div class="stacked-segment" style="width:' + pct.toFixed(2) + '%; background-color:' +
                    s.color + ';" title="' + s.name + '">' + label + '</div>';
            }).join('');

            legend.innerHTML = segments.map(s =>
                '<span><span class="comp-dot" style="background-color:' + s.color + ';"></span>' +
                s.name + ' ' + ((s.value / total) * 100).toFixed(0) + '%</span>').join('');
        }

        // ---- Usage limit tiles ----

        function limitColor(pct) {
            return pct >= 80 ? '#ff6b6b' : pct >= 60 ? '#ffd93d' : '#51cf66';
        }

        // Update one tile. A null/undefined percent means "not reported": the tile
        // stays in place showing a dash so the grid keeps its three columns.
        function updateLimitTile(id, percent, sub, approximate) {
            const valueElem = document.getElementById(id + '-value');
            const fillElem = document.getElementById(id + '-fill');
            const subElem = document.getElementById(id + '-sub');
            if (!valueElem || !fillElem) { return; }

            const known = typeof percent === 'number';
            const color = known ? limitColor(percent) : 'var(--vscode-descriptionForeground)';

            valueElem.textContent = known ? (approximate ? '~' : '') + Math.round(percent) + '%' : '—';
            valueElem.style.color = color;
            fillElem.style.width = (known ? Math.min(percent, 100) : 0) + '%';
            fillElem.style.backgroundColor = known ? color : 'transparent';
            if (subElem && sub) { subElem.textContent = sub; }
        }

        function resetCaption(window, withDate) {
            if (!window) { return 'not reported'; }
            const d = new Date(window.resetsAt);
            const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return withDate ? 'resets ' + d.toLocaleDateString() + ' ' + time : 'resets ' + time;
        }

        function ageLabel(iso) {
            const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
            if (minutes < 1) { return 'just now'; }
            if (minutes < 60) { return minutes + ' min ago'; }
            return Math.floor(minutes / 60) + ' h ago';
        }

        // Per-session context rows. The DOM order is fixed by the last render;
        // only values move, so a session overtaking another does not reshuffle
        // the list under the cursor.
        function updateSessionContexts(rows) {
            if (!rows) { return; }
            for (const row of rows) {
                const id = 'sess-' + String(row.sessionId).replace(/[^\\w-]/g, '');
                const known = typeof row.contextPercent === 'number';
                const meta = document.getElementById(id + '-meta');
                if (meta) {
                    meta.textContent = percentLabel(row) + ' · ' + ageLabel(row.updatedAt);
                }
                const fill = document.getElementById(id + '-fill');
                if (fill) {
                    fill.style.width = (known ? Math.min(row.contextPercent, 100) : 0) + '%';
                    fill.style.backgroundColor = known ? limitColor(row.contextPercent) : 'transparent';
                }
            }
        }

        // ---- Context tile rotation ----
        //
        // The tile has room for one session, and with several open the "newest"
        // one flips every time another session replies - the number appeared to
        // jump at random. It now cycles instead, naming whose context it shows.
        let contextRows = [];
        let contextIndex = 0;
        let fallbackContext;

        function percentLabel(row) {
            if (typeof row.contextPercent !== 'number') { return '—'; }
            return (row.estimated ? '~' : '') + Math.round(row.contextPercent) + '%';
        }

        function contextCaption(rows, index) {
            const row = rows[index];
            if (!row) { return 'current Claude Code session'; }
            return rows.length > 1 ? row.label + ' · ' + (index + 1) + '/' + rows.length : row.label;
        }

        function renderContextTile() {
            const row = contextRows[contextIndex];
            updateLimitTile('ctx',
                row ? row.contextPercent : fallbackContext,
                contextCaption(contextRows, contextIndex),
                Boolean(row && row.estimated));
        }

        const CONTEXT_ROTATION_MS = 2000;
        setInterval(function () {
            if (contextRows.length < 2) { return; }
            contextIndex = (contextIndex + 1) % contextRows.length;
            renderContextTile();
        }, CONTEXT_ROTATION_MS);

        function updateLimitTiles(rateLimits, sessionContexts) {
            updateSessionContexts(sessionContexts);
            contextRows = sessionContexts || [];
            fallbackContext = rateLimits && rateLimits.contextUsedPercent;
            // A session can end between refreshes; keep pointing at a real row.
            if (contextIndex >= contextRows.length) { contextIndex = 0; }
            renderContextTile();
            if (!rateLimits) { return; }
            updateLimitTile('five-hour', rateLimits.fiveHour && rateLimits.fiveHour.usedPercent,
                resetCaption(rateLimits.fiveHour, false));
            updateLimitTile('seven-day', rateLimits.sevenDay && rateLimits.sevenDay.usedPercent,
                resetCaption(rateLimits.sevenDay, true));
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
        // Shades per family, so two models of the same family sitting next to each
        // other in a composition bar are still distinguishable.
        const TIER_SHADES = {
            fable: ['#c084fc', '#5b21b6', '#e9d5ff', '#8b5cf6'],
            opus: ['#ff6b6b', '#a51111', '#ffc9c9', '#e03131'],
            sonnet: ['#4dabf7', '#0b4a8f', '#a5d8ff', '#1c7ed6'],
            haiku: ['#51cf66', '#1a6b2a', '#b2f2bb', '#2f9e44'],
            unknown: ['#868e96', '#343a40', '#ced4da', '#5c636a']
        };
        const MODEL_COLORS = {
            fable: TIER_SHADES.fable[0],
            opus: TIER_SHADES.opus[0],
            sonnet: TIER_SHADES.sonnet[0],
            haiku: TIER_SHADES.haiku[0],
            unknown: TIER_SHADES.unknown[0]
        };
        function tierShade(tier, i) {
            const shades = TIER_SHADES[tier] || TIER_SHADES.unknown;
            return shades[i % shades.length];
        }
        function tierOf(id) {
            return /fable|mythos/.test(id) ? 'fable'
                : id.includes('opus') ? 'opus'
                : id.includes('haiku') ? 'haiku'
                : id.includes('sonnet') ? 'sonnet' : 'unknown';
        }
        function hueDistance(a, b) {
            const d = Math.abs(a - b) % 360;
            return d > 180 ? 360 - d : d;
        }
        // Stable per-project colours, nudged apart when two hash to nearly the
        // same hue. Mirrors projectColors() on the extension side.
        function projectColors(labels) {
            const hues = [];
            for (const label of labels) {
                let hue = Math.abs(hashCode(label) % 360);
                let guard = 0;
                while (hues.some(h => hueDistance(h, hue) < 30) && guard < 12) {
                    hue = (hue + 47) % 360;
                    guard++;
                }
                hues.push(hue);
            }
            return hues.map(h => 'hsl(' + h + ', 65%, 55%)');
        }
        function hashCode(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            return hash;
        }

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

        // Initialize all components when DOM is ready
        window.addEventListener('DOMContentLoaded', () => {
            // 1. Initialize zoom controls
            applyZoom(currentZoom);

            const zoomOutBtn = document.getElementById('zoom-out');
            const zoomInBtn = document.getElementById('zoom-in');
            const percentElem = document.getElementById('zoom-percent');

            if (zoomOutBtn) {
                zoomOutBtn.addEventListener('click', () => {
                    if (currentZoom > MIN_ZOOM) {
                        applyZoom(currentZoom - ZOOM_STEP);
                    }
                });
            }

            if (zoomInBtn) {
                zoomInBtn.addEventListener('click', () => {
                    if (currentZoom < MAX_ZOOM) {
                        applyZoom(currentZoom + ZOOM_STEP);
                    }
                });
            }

            if (percentElem) {
                percentElem.addEventListener('click', () => {
                    applyZoom(DEFAULT_ZOOM);
                });
            }

            // 2. Restore collapsed section states
            restoreCollapsedStates();

            // 3. Initialize breakdowns
            const session = ${JSON.stringify({
              totalTokens: session.totalTokens,
              modelBreakdown: session.modelBreakdown,
              projectBreakdown: session.projectBreakdown
            })};

            // Model breakdown
            if (session.modelBreakdown) {
                const modelSegments = [
                    { name: 'Fable', value: session.modelBreakdown.fable, color: MODEL_COLORS.fable },
                    { name: 'Opus', value: session.modelBreakdown.opus, color: MODEL_COLORS.opus },
                    { name: 'Sonnet', value: session.modelBreakdown.sonnet, color: MODEL_COLORS.sonnet },
                    { name: 'Haiku', value: session.modelBreakdown.haiku, color: MODEL_COLORS.haiku },
                    { name: 'Other', value: session.modelBreakdown.unknown, color: MODEL_COLORS.unknown }
                ].filter(s => s.value > 0).map(s => ({
                    ...s,
                    percent: (s.value / session.totalTokens) * 100
                }));

                renderStackedBar('model-stacked-bar', modelSegments);
                renderBreakdownList('model-breakdown-list', modelSegments);
            }

            // Project breakdown
            if (session.projectBreakdown) {
                const projectEntries = Object.entries(session.projectBreakdown)
                    .filter(([name, value]) => value > 0)
                    .sort((a, b) => b[1] - a[1]);
                // Same colour source as the Message Count composition bar, so a
                // project looks the same everywhere in the panel
                const projectPalette = projectColors(projectEntries.map(([name]) => name));
                const projectSegments = projectEntries.map(([name, value], i) => ({
                    name: name,
                    value: value,
                    color: projectPalette[i],
                    percent: (value / session.totalTokens) * 100
                }));

                renderStackedBar('project-stacked-bar', projectSegments);
                renderBreakdownList('project-breakdown-list', projectSegments);
            }
        });
    </script>
</head>
<body>
    <h1>
        <span class="header-title">Claude Code Statistics</span>
        <div class="zoom-controls">
            <div class="zoom-button" id="zoom-out" title="Decrease size">−</div>
            <div class="zoom-percent" id="zoom-percent" title="Click to reset">100%</div>
            <div class="zoom-button" id="zoom-in" title="Increase size">+</div>
        </div>
    </h1>
    <div id="project-name" class="project-name" style="display: ${showProjectName ? 'block' : 'none'};">
        Project: <strong>${workspaceName}</strong>
    </div>

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
${limitsSection}

    <div class="section-header" onclick="toggleSection('token-details')">
        <h2>Token Usage</h2>
        <div class="collapse-toggle">
            <span class="collapse-arrow collapsed" id="token-details-arrow">▼</span>More...
        </div>
    </div>
    <div class="metric-section">
        <div class="progress-container${containerClass(tokenPercent)}" id="token-container">
            <div class="progress-label">
                <span id="token-label"><strong>${session.totalTokens.toLocaleString()}</strong>${planConfig.tokenLimit ? ` / ${planConfig.tokenLimit.toLocaleString()}` : ''} tokens</span>
                <span id="token-percent"><strong>${formatPercent(tokenPercent)}</strong></span>
            </div>
            <div class="progress-bar" id="token-bar"${barVisibility(tokenPercent)}>
                <div class="progress-fill" id="token-fill" style="width: ${Math.min(tokenPercent ?? 0, 100)}%; background-color: ${tokenColor};">
                    <span id="token-fill-text">${formatPercent(tokenPercent)}</span>
                </div>
            </div>${tokenPercent === undefined ? renderCompositionBar('token', tokenSegments(session)) : ''}
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

            ${tokenPercent === undefined ? '' : `<h2 style="margin-top: 20px;">Token Usage by Model</h2>
            <div class="stacked-bar" id="model-stacked-bar"></div>
            <div class="breakdown-list" id="model-breakdown-list"></div>`}

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
        <div class="progress-container${containerClass(costPercent)}" id="cost-container">
            <div class="progress-label">
                <span id="cost-label"><strong>${formatCost(session.totalCost)}</strong>${session.costLimit ? ` / ${formatCost(session.costLimit)}` : ''}</span>
                <span id="cost-percent"><strong>${formatPercent(costPercent)}</strong></span>
            </div>
            <div class="progress-bar" id="cost-bar"${barVisibility(costPercent)}>
                <div class="progress-fill" id="cost-fill" style="width: ${Math.min(costPercent ?? 0, 100)}%; background-color: ${costColor};">
                    <span id="cost-fill-text">${formatPercent(costPercent)}</span>
                </div>
            </div>${costPercent === undefined ? renderCompositionBar('cost', costSegments(session)) : ''}
        </div>
        <div class="collapsible-content collapsed" id="cost-details-content">
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">Cost Burn Rate</div>
                    <div class="info-value" id="cost-burn-rate">${formatCost(session.costBurnRate)}/min</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Last 7 days</div>
                    <div class="info-value" id="week-cost">${formatCost(session.weekCost)}</div>
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
        <div class="progress-container${containerClass(messagePercent)}" id="message-container">
            <div class="progress-label">
                <span id="message-label"><strong>${session.messageCount}</strong>${session.messageLimit ? ` / ${session.messageLimit}` : ''} messages</span>
                <span id="message-percent"><strong>${formatPercent(messagePercent)}</strong></span>
            </div>
            <div class="progress-bar" id="message-bar"${barVisibility(messagePercent)}>
                <div class="progress-fill" id="message-fill" style="width: ${Math.min(messagePercent ?? 0, 100)}%; background-color: ${messageColor};">
                    <span id="message-fill-text">${formatPercent(messagePercent)}</span>
                </div>
            </div>${messagePercent === undefined ? renderCompositionBar('message', messageSegments(session)) : ''}
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
