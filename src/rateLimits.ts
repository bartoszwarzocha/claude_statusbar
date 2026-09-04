import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { RateLimitSnapshot, RateLimitWindow } from './types';

/**
 * Bridge to Claude Code's authoritative rate limit data.
 *
 * Claude Code exposes the real 5-hour and 7-day usage percentages (and their
 * reset timestamps) ONLY in the JSON it pipes to a status line command - no hook
 * receives them, and they are not written to the transcript. So we install a
 * tiny status line script that mirrors that JSON to a file, then watch the file.
 *
 * Reference: https://code.claude.com/docs/en/statusline
 *   rate_limits.five_hour.used_percentage / .resets_at
 *   rate_limits.seven_day.used_percentage / .resets_at
 *
 * The data appears only for Claude.ai (Pro/Max) subscribers, and only after the
 * first API response in a session - every field is treated as optional.
 */

const BRIDGE_STATE_FILE = 'claude-statusbar-bridge.json';
/** One file per Claude Code session - a shared file would race with 10 sessions rendering */
const BRIDGE_SESSIONS_DIR = 'claude-statusbar-sessions';
/** Bumped whenever the installed script changes, so it can be refreshed silently */
const BRIDGE_SCRIPT_VERSION = 3;
const BRIDGE_SCRIPT_FILE = 'claude-statusbar-bridge.js';
const BRIDGE_BACKUP_FILE = 'claude-statusbar-bridge-backup.json';

/** Snapshots older than this are considered stale and no longer displayed */
const MAX_SNAPSHOT_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * How often Claude Code re-runs the status line, and so how fresh the rate
 * limits can be. Measured: with this set the snapshot lands every 10 s on the
 * dot; without it, only when a session redraws.
 */
const STATUS_LINE_REFRESH_SECONDS = 10;

/**
 * The status line script installed into the user's Claude config directory.
 *
 * It must be well behaved: Claude Code runs it on every render, so it writes
 * atomically, never throws, and preserves any pre-existing status line by
 * delegating to it with the same stdin.
 */
const BRIDGE_SCRIPT = `#!/usr/bin/env node
// Installed by the "Claude Code Status Bar Monitor" VS Code extension.
// Mirrors Claude Code's status line JSON (which is the only place the real
// 5-hour / 7-day rate limit numbers are exposed) to a file the extension reads.
// Safe to delete: the extension will simply fall back to local estimates.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const BRIDGE_VERSION = ${BRIDGE_SCRIPT_VERSION};
const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const stateFile = path.join(dir, ${JSON.stringify(BRIDGE_STATE_FILE)});
const backupFile = path.join(dir, ${JSON.stringify(BRIDGE_BACKUP_FILE)});
const sessionsDir = path.join(dir, ${JSON.stringify(BRIDGE_SESSIONS_DIR)});

// Every open session renders the status line, and each one carries the rate
// limits IT last saw in an API response - a session sitting idle keeps
// reporting its old numbers with a fresh timestamp. Last writer wins therefore
// made the shared snapshot flicker between sessions (measured: 11%, 10% and 2%
// inside one second with ten sessions open). So the windows are merged instead:
// usage only grows inside a window, which makes the highest reading the newest.
function mergeWindow(incoming, existing, now) {
  // A window whose reset has passed says nothing about the one running now.
  const current =
    existing && typeof existing === 'object' &&
    typeof existing.resets_at === 'number' && existing.resets_at * 1000 > now
      ? existing
      : null;
  if (!incoming || typeof incoming !== 'object') { return current; }
  if (!current) { return incoming; }
  if (typeof incoming.resets_at === 'number' && incoming.resets_at !== current.resets_at) {
    return incoming.resets_at > current.resets_at ? incoming : current;
  }
  const a = incoming.used_percentage;
  const b = current.used_percentage;
  if (typeof a !== 'number') { return current; }
  if (typeof b !== 'number') { return incoming; }
  return a >= b ? incoming : current;
}

// Merges every window Claude Code reports - Max plans have more than two - and
// says whether this session's own reading won anywhere, which is what dates the
// numbers, rather than the time of the write.
function mergeRateLimits(incoming, existing, now) {
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const old = existing && typeof existing === 'object' ? existing : {};
  const keys = Object.keys(inc);
  for (const key of Object.keys(old)) {
    if (keys.indexOf(key) === -1) { keys.push(key); }
  }
  const merged = {};
  let any = false;
  let confirmed = false;
  for (const key of keys) {
    const win = mergeWindow(inc[key], old[key], now);
    if (!win) { continue; }
    merged[key] = win;
    any = true;
    if (win === inc[key]) { confirmed = true; }
  }
  return { limits: any ? merged : null, confirmed: confirmed };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* ignore malformed input */ }

  if (parsed) {
    try {
      const now = Date.now();
      let previous = null;
      try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { /* first run */ }
      const rl = mergeRateLimits(parsed.rate_limits, previous && previous.rate_limits, now);
      const previousAt =
        previous && typeof previous.rate_limits_at === 'number' ? previous.rate_limits_at : 0;
      const snapshot = {
        written_at: now,
        // When this session's reading lost to a higher one, the numbers are as
        // old as whoever last confirmed them - say so instead of restamping.
        rate_limits_at: (rl.confirmed || !previousAt) ? now : previousAt,
        rate_limits: rl.limits,
        cost: parsed.cost || null,
        context_window: parsed.context_window
          ? {
              used_percentage: parsed.context_window.used_percentage,
              context_window_size: parsed.context_window.context_window_size,
            }
          : null,
        model: parsed.model || null,
        effort: parsed.effort || null,
        fast_mode: parsed.fast_mode === true,
        session_id: parsed.session_id || null,
        version: parsed.version || null,
      };
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (e) { /* never block the status line on a write failure */ }

    // Context usage is per session, so every session also records its own file.
    // The shared snapshot above only ever holds whichever session rendered last.
    try {
      if (parsed.session_id) {
        const safeId = String(parsed.session_id).replace(/[^\\w.-]/g, '_');
        const ws = parsed.workspace || {};
        const entry = {
          version: BRIDGE_VERSION,
          written_at: Date.now(),
          session_id: parsed.session_id,
          session_name: parsed.session_name || null,
          project_dir: ws.project_dir || ws.current_dir || null,
          model: parsed.model ? parsed.model.display_name || parsed.model.id : null,
          context_used_percentage: parsed.context_window
            ? parsed.context_window.used_percentage
            : null,
          context_window_size: parsed.context_window
            ? parsed.context_window.context_window_size
            : null,
        };
        fs.mkdirSync(sessionsDir, { recursive: true });
        const target = path.join(sessionsDir, safeId + '.json');
        const tmp2 = target + '.tmp';
        fs.writeFileSync(tmp2, JSON.stringify(entry), 'utf8');
        fs.renameSync(tmp2, target);
      }
    } catch (e) { /* per-session detail is a nice-to-have, never fatal */ }
  }

  // Preserve whatever status line the user had before we were installed.
  let delegate = null;
  try {
    delegate = JSON.parse(fs.readFileSync(backupFile, 'utf8')).delegate || null;
  } catch (e) { /* no delegate configured */ }

  if (delegate && typeof delegate === 'string' && delegate.trim()) {
    const { spawn } = require('child_process');
    const child = spawn(delegate, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => { process.stdout.write(fallbackLine(parsed)); });
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
    return;
  }

  process.stdout.write(fallbackLine(parsed));
});

function fallbackLine(d) {
  if (!d) { return ''; }
  const parts = [];
  if (d.model && d.model.display_name) { parts.push('[' + d.model.display_name + ']'); }
  if (d.context_window && d.context_window.used_percentage != null) {
    parts.push(Math.round(d.context_window.used_percentage) + '% ctx');
  }
  const rl = d.rate_limits || {};
  if (rl.five_hour && rl.five_hour.used_percentage != null) {
    parts.push('5h ' + Math.round(rl.five_hour.used_percentage) + '%');
  }
  if (rl.seven_day && rl.seven_day.used_percentage != null) {
    parts.push('7d ' + Math.round(rl.seven_day.used_percentage) + '%');
  }
  return parts.join(' | ');
}
`;

export interface BridgeStatus {
  installed: boolean;
  /** true when settings.json points at our script */
  active: boolean;
  /** A third-party status line we are delegating to, if any */
  delegate?: string;
  /** Last snapshot age in ms, if a snapshot exists */
  snapshotAgeMs?: number;
  claudeDir: string;
}

/**
 * Resolve the Claude config directory (CLAUDE_CONFIG_DIR wins, then ~/.claude).
 */
export function getClaudeConfigDir(): string {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(envDir)) {
    return envDir;
  }
  return path.join(os.homedir(), '.claude');
}

function bridgeScriptPath(dir = getClaudeConfigDir()): string {
  return path.join(dir, BRIDGE_SCRIPT_FILE);
}

function bridgeStatePath(dir = getClaudeConfigDir()): string {
  return path.join(dir, BRIDGE_STATE_FILE);
}

function bridgeBackupPath(dir = getClaudeConfigDir()): string {
  return path.join(dir, BRIDGE_BACKUP_FILE);
}

function bridgeSessionsDir(dir = getClaudeConfigDir()): string {
  return path.join(dir, BRIDGE_SESSIONS_DIR);
}

function settingsPath(dir = getClaudeConfigDir()): string {
  return path.join(dir, 'settings.json');
}

function parseWindow(raw: any): RateLimitWindow | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const pct = raw.used_percentage;
  const resets = raw.resets_at;
  if (typeof pct !== 'number' || typeof resets !== 'number') {
    return undefined;
  }
  return {
    usedPercent: Math.max(0, Math.min(100, pct)),
    // resets_at is Unix epoch SECONDS
    resetsAt: new Date(resets * 1000),
  };
}

/**
 * The highest reading seen in the window that is currently running, per config
 * directory.
 *
 * The bridge script merges the windows itself, but an install still running an
 * older script clobbers the shared file with whatever session rendered last, so
 * the same rule is applied here as well: within one window usage only grows,
 * which makes the highest reading the newest one.
 */
const windowMemory = new Map<string, { fiveHour?: RateLimitWindow; sevenDay?: RateLimitWindow }>();

/**
 * Choose between a fresh reading and the best one seen so far. A later reset is
 * a new window and wins outright; inside one window the higher percentage wins.
 * Exported for testing.
 */
export function pickCurrentWindow(
  incoming: RateLimitWindow | undefined,
  remembered: RateLimitWindow | undefined,
  now: number
): RateLimitWindow | undefined {
  // Once a window has reset, what it was holding says nothing about the new one.
  const current = remembered && remembered.resetsAt.getTime() > now ? remembered : undefined;
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  if (incoming.resetsAt.getTime() !== current.resetsAt.getTime()) {
    return incoming.resetsAt.getTime() > current.resetsAt.getTime() ? incoming : current;
  }
  return incoming.usedPercent >= current.usedPercent ? incoming : current;
}

/** Discard the remembered windows - the bridge is gone, so its readings are too */
export function forgetRateLimitWindows(): void {
  windowMemory.clear();
}

/**
 * Read the most recent snapshot written by the bridge script.
 * Returns undefined when the bridge is not installed, has never run, or the
 * data is too old to be meaningful.
 */
export function readRateLimits(dir = getClaudeConfigDir()): RateLimitSnapshot | undefined {
  const file = bridgeStatePath(dir);

  let raw: string;
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const writtenAt = typeof parsed.written_at === 'number' ? parsed.written_at : 0;
  if (!writtenAt || Date.now() - writtenAt > MAX_SNAPSHOT_AGE_MS) {
    return undefined;
  }

  // Bridge v3 dates the windows separately from the write: the file is rewritten
  // every few seconds by whichever session happened to render, but the numbers
  // are only as fresh as the last session that actually confirmed them.
  const limitsAt = typeof parsed.rate_limits_at === 'number' ? parsed.rate_limits_at : writtenAt;
  if (Date.now() - limitsAt > MAX_SNAPSHOT_AGE_MS) {
    return undefined;
  }

  const now = Date.now();
  const remembered = windowMemory.get(dir) ?? {};
  const rl = parsed.rate_limits || {};
  const fiveHour = pickCurrentWindow(parseWindow(rl.five_hour), remembered.fiveHour, now);
  const sevenDay = pickCurrentWindow(parseWindow(rl.seven_day), remembered.sevenDay, now);
  windowMemory.set(dir, { fiveHour, sevenDay });

  const snapshot: RateLimitSnapshot = {
    fiveHour,
    sevenDay,
    updatedAt: new Date(limitsAt),
  };

  if (parsed.cost && typeof parsed.cost.total_cost_usd === 'number') {
    snapshot.sessionCostUsd = parsed.cost.total_cost_usd;
  }
  if (parsed.context_window && typeof parsed.context_window.used_percentage === 'number') {
    snapshot.contextUsedPercent = parsed.context_window.used_percentage;
  }
  if (parsed.model && typeof parsed.model.id === 'string') {
    snapshot.model = parsed.model.id;
  }
  if (parsed.effort && typeof parsed.effort.level === 'string') {
    snapshot.effortLevel = parsed.effort.level;
  }
  snapshot.fastMode = parsed.fast_mode === true;

  // A snapshot with neither window carries no rate limit information
  if (!fiveHour && !sevenDay) {
    return undefined;
  }

  return snapshot;
}

/**
 * The context window size Claude Code last reported, at any age.
 *
 * Deliberately ignores the staleness cut-off that `readRateLimits` applies: a
 * percentage from yesterday is misleading, but the size of the window is a
 * property of the plan and the model, and yesterday's answer is still the right
 * denominator for a session the bridge cannot see today.
 */
export function readBridgeContextWindowSize(dir = getClaudeConfigDir()): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(bridgeStatePath(dir), 'utf8'));
    const size = parsed?.context_window?.context_window_size;
    return typeof size === 'number' && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Context usage reported per Claude Code session.
 *
 * The context window belongs to a single conversation, not to the account, so
 * with several sessions open there is no single "the" context - each writes its
 * own file and the extension shows them side by side. A session that has not
 * been touched in a while keeps its last reported value; `updatedAt` says how
 * old it is.
 */
export interface SessionContext {
  sessionId: string;
  /** Project folder name, the most recognisable label available */
  label: string;
  contextPercent?: number;
  contextWindowSize?: number;
  model?: string;
  /** Conversation title, used as hover text - often too long to display inline */
  title?: string;
  updatedAt: Date;
}

/** How long a session entry stays interesting after its last render */
const MAX_SESSION_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Read the per-session context files, newest first. Stale entries are dropped
 * from the result and deleted, so the directory does not grow without bound.
 */
export function readSessionContexts(dir = getClaudeConfigDir()): SessionContext[] {
  const sessionsDir = bridgeSessionsDir(dir);
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const out: SessionContext[] = [];
  for (const file of files) {
    const full = path.join(sessionsDir, file);
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }

    const writtenAt = typeof parsed.written_at === 'number' ? parsed.written_at : 0;
    if (!writtenAt || Date.now() - writtenAt > MAX_SESSION_AGE_MS) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* best effort */
      }
      continue;
    }

    const projectDir: string | undefined =
      typeof parsed.project_dir === 'string' ? parsed.project_dir : undefined;
    // Project folder first: it is short, stable, and matches how the work is
    // organised. The conversation title is often a long sentence that would be
    // truncated, so it becomes the hover text instead.
    const label =
      (projectDir ? path.basename(projectDir) : undefined) ||
      (typeof parsed.session_name === 'string' && parsed.session_name) ||
      String(parsed.session_id || file).slice(0, 8);

    out.push({
      sessionId: String(parsed.session_id || file.replace(/\.json$/, '')),
      label,
      contextPercent:
        typeof parsed.context_used_percentage === 'number'
          ? parsed.context_used_percentage
          : undefined,
      contextWindowSize:
        typeof parsed.context_window_size === 'number' ? parsed.context_window_size : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      title: typeof parsed.session_name === 'string' ? parsed.session_name : undefined,
      updatedAt: new Date(writtenAt),
    });
  }

  return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** Directory the extension should watch for per-session changes */
export function getSessionsDirPath(dir = getClaudeConfigDir()): string {
  return bridgeSessionsDir(dir);
}

/**
 * Rewrite the installed script when it predates the current one. It is our own
 * file, so refreshing it silently is preferable to asking the user to re-run the
 * setup after every extension update.
 */
export function refreshBridgeScriptIfOutdated(dir = getClaudeConfigDir()): boolean {
  const scriptPath = bridgeScriptPath(dir);
  let existing: string;
  try {
    existing = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return false; // not installed - nothing to refresh
  }

  if (existing === BRIDGE_SCRIPT) {
    return false;
  }

  try {
    fs.writeFileSync(scriptPath, BRIDGE_SCRIPT, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Path the extension should watch for changes */
export function getRateLimitFilePath(dir = getClaudeConfigDir()): string {
  return bridgeStatePath(dir);
}

/**
 * Add `refreshInterval` to a status line installed before we set it.
 *
 * Bridges installed by 0.5.0 only refreshed when a terminal session redrew,
 * which is what made the percentages look frozen. Backfilling it silently is
 * preferable to asking the user to re-run the setup, and it is left alone if
 * they have chosen their own interval.
 */
export function ensureStatusLineRefreshInterval(dir = getClaudeConfigDir()): boolean {
  const settings = readSettings(dir);
  const statusLine = settings?.statusLine;
  const command: unknown = statusLine?.command;
  const isOurs = typeof command === 'string' && command.includes(BRIDGE_SCRIPT_FILE);

  if (!isOurs || typeof statusLine.refreshInterval === 'number') {
    return false;
  }

  statusLine.refreshInterval = STATUS_LINE_REFRESH_SECONDS;
  try {
    writeSettingsAtomic(dir, settings);
    return true;
  } catch {
    return false;
  }
}

function readSettings(dir: string): any {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8'));
  } catch {
    return {};
  }
}

function expectedCommand(dir: string): string {
  return `node "${bridgeScriptPath(dir)}"`;
}

/**
 * Report whether the bridge is installed and wired into Claude Code settings.
 */
export function getBridgeStatus(dir = getClaudeConfigDir()): BridgeStatus {
  const scriptExists = fs.existsSync(bridgeScriptPath(dir));
  const settings = readSettings(dir);
  const command: unknown = settings?.statusLine?.command;
  const active =
    scriptExists &&
    typeof command === 'string' &&
    command.includes(BRIDGE_SCRIPT_FILE);

  let delegate: string | undefined;
  try {
    const backup = JSON.parse(fs.readFileSync(bridgeBackupPath(dir), 'utf8'));
    if (typeof backup.delegate === 'string' && backup.delegate.trim()) {
      delegate = backup.delegate;
    }
  } catch {
    /* no backup */
  }

  const status: BridgeStatus = { installed: scriptExists, active, delegate, claudeDir: dir };

  try {
    const stat = fs.statSync(bridgeStatePath(dir));
    status.snapshotAgeMs = Date.now() - stat.mtimeMs;
  } catch {
    /* no snapshot yet */
  }

  return status;
}

/** Verify `node` is callable from a shell, which the status line command needs */
export function checkNodeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('node', ['--version'], { timeout: 5000, shell: true }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Install the status line bridge.
 *
 * Writes the script, backs up any existing status line command (so it keeps
 * working via delegation and can be restored), and points settings.json at us.
 */
export function installBridge(dir = getClaudeConfigDir()): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(bridgeScriptPath(dir), BRIDGE_SCRIPT, 'utf8');

  const settings = readSettings(dir);
  const existing = settings.statusLine;
  const existingCommand: string | undefined =
    existing && typeof existing.command === 'string' ? existing.command : undefined;

  // Preserve a third-party status line unless it is already ours
  const isOurs = existingCommand?.includes(BRIDGE_SCRIPT_FILE) ?? false;
  const backup = {
    delegate: isOurs ? readDelegate(dir) : existingCommand ?? null,
    previousStatusLine: isOurs ? readPreviousStatusLine(dir) : existing ?? null,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(bridgeBackupPath(dir), JSON.stringify(backup, null, 2), 'utf8');

  settings.statusLine = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    type: 'command',
    command: expectedCommand(dir),
    // Without this the status line runs only when a session redraws, so the
    // rate limits freeze for as long as the terminal sits idle - and they freeze
    // for the whole session when the work happens in the VS Code extension,
    // which redraws nothing. With it, any open terminal session keeps the
    // account-wide numbers current. Supported since Claude Code 2.1.97.
    refreshInterval: STATUS_LINE_REFRESH_SECONDS,
  };

  writeSettingsAtomic(dir, settings);
}

function readDelegate(dir: string): string | null {
  try {
    const backup = JSON.parse(fs.readFileSync(bridgeBackupPath(dir), 'utf8'));
    return typeof backup.delegate === 'string' ? backup.delegate : null;
  } catch {
    return null;
  }
}

function readPreviousStatusLine(dir: string): any {
  try {
    const backup = JSON.parse(fs.readFileSync(bridgeBackupPath(dir), 'utf8'));
    return backup.previousStatusLine ?? null;
  } catch {
    return null;
  }
}

/**
 * Remove the bridge and restore whatever status line was configured before.
 */
export function uninstallBridge(dir = getClaudeConfigDir()): void {
  const settings = readSettings(dir);
  const command: unknown = settings?.statusLine?.command;

  if (typeof command === 'string' && command.includes(BRIDGE_SCRIPT_FILE)) {
    const previous = readPreviousStatusLine(dir);
    if (previous) {
      settings.statusLine = previous;
    } else {
      delete settings.statusLine;
    }
    writeSettingsAtomic(dir, settings);
  }

  for (const file of [bridgeScriptPath(dir), bridgeStatePath(dir), bridgeBackupPath(dir)]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  try {
    fs.rmSync(bridgeSessionsDir(dir), { recursive: true, force: true });
  } catch {
    /* already gone */
  }

  // Nothing is feeding us any more, so the best-reading memory must go too -
  // otherwise a reinstall would start from percentages nobody is confirming.
  forgetRateLimitWindows();
}

/**
 * Write settings.json without risking a truncated file on crash, keeping a
 * one-off backup the first time we touch it.
 */
function writeSettingsAtomic(dir: string, settings: any): void {
  const target = settingsPath(dir);
  const backup = `${target}.claude-statusbar.bak`;

  if (fs.existsSync(target) && !fs.existsSync(backup)) {
    try {
      fs.copyFileSync(target, backup);
    } catch {
      /* best effort */
    }
  }

  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}
