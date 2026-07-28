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
const BRIDGE_SCRIPT_FILE = 'claude-statusbar-bridge.js';
const BRIDGE_BACKUP_FILE = 'claude-statusbar-bridge-backup.json';

/** Snapshots older than this are considered stale and no longer displayed */
const MAX_SNAPSHOT_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

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

const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const stateFile = path.join(dir, ${JSON.stringify(BRIDGE_STATE_FILE)});
const backupFile = path.join(dir, ${JSON.stringify(BRIDGE_BACKUP_FILE)});

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* ignore malformed input */ }

  if (parsed) {
    try {
      const snapshot = {
        written_at: Date.now(),
        rate_limits: parsed.rate_limits || null,
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

  const rl = parsed.rate_limits || {};
  const fiveHour = parseWindow(rl.five_hour);
  const sevenDay = parseWindow(rl.seven_day);

  const snapshot: RateLimitSnapshot = {
    fiveHour,
    sevenDay,
    updatedAt: new Date(writtenAt),
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

/** Path the extension should watch for changes */
export function getRateLimitFilePath(dir = getClaudeConfigDir()): string {
  return bridgeStatePath(dir);
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
