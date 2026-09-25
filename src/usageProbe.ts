import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { RateLimitWindow } from './types';

/**
 * Asks Claude Code itself for the 5-hour and weekly usage.
 *
 * `claude -p /usage` runs the same local command as typing /usage in a session:
 * Claude Code fetches the numbers with its own sign-in and prints them. No model
 * is called (measured: cost 0, zero turns) and, with --no-session-persistence,
 * no transcript is written. This is what makes the limits available to people
 * who never open a terminal - the status line bridge only ever sees terminal
 * sessions, and Claude Code's VS Code extension renders no status line.
 *
 * The extension never touches credentials: it only starts a program the user
 * already has - the copy bundled with the Claude Code VS Code extension, or the
 * CLI - and reads what it prints.
 *
 * The output is text meant for people, so the parser below is deliberately
 * tolerant: it recognises the windows by their labels, the percentage in either
 * "used" or "left" form, and the reset time in every format Claude Code has used
 * or is likely to use (clock times with or without a date, 12- and 24-hour,
 * relative "in 3h 20m", ISO timestamps, an IANA time zone in brackets).
 */

/** Guards passed on every run. Each one is also understood by older versions. */
const PROBE_ARGS = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  // Without this every probe would leave a transcript behind, and the extension
  // would list its own probes as sessions.
  '--no-session-persistence',
  // Belt and braces should a future version stop treating /usage as a local
  // command and send it to the model instead: cheapest model, hard spend cap.
  // interpretProbeOutput() also detects that case and stops probing.
  '--model',
  'haiku',
  '--max-budget-usd',
  '0.05',
];

/**
 * Settings for the probe run only. Hooks (SessionStart and the like) are the
 * user's business, not the probe's; auto-memory would otherwise create an empty
 * project folder for the probe's working directory under ~/.claude/projects.
 */
const PROBE_SETTINGS = JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false });

/** The first run analyses the local history and was measured at ~40 s */
const PROBE_TIMEOUT_MS = 120_000;

export type UsageProbeKind =
  /** At least one window was read */
  | 'limits'
  /** Claude Code answered, but reports no windows - API key, Bedrock, Vertex... */
  | 'no-limits'
  /** Claude Code answered with percentages we could not attribute to a window */
  | 'unrecognised'
  /** /usage was sent to the model instead of run locally - never probe again */
  | 'charged'
  /** The program could not be run, timed out, or printed nothing usable */
  | 'failed';

export interface UsageProbeResult {
  kind: UsageProbeKind;
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
  /** Claude Code's own first line, shown to the user when there are no windows */
  summary?: string;
  /** Diagnostics for the output channel */
  detail?: string;
  at: Date;
  executable?: string;
}

// ---------------------------------------------------------------------------
// Finding the program
// ---------------------------------------------------------------------------

/**
 * Every place a Claude Code executable may live, most likely first, existing
 * files only.
 *
 * @param bundledRoots install folders of the Claude Code VS Code extension. It
 *   ships its own copy of the program, which is what makes this work for people
 *   who have never installed the CLI - that copy is not on PATH.
 */
export function findClaudeExecutables(bundledRoots: string[]): string[] {
  const isWindows = process.platform === 'win32';
  const home = os.homedir();
  const candidates: string[] = [];

  // 1. The CLI, if installed: usually newer than the bundled copy
  const names = isWindows ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) {
      for (const name of names) {
        candidates.push(path.join(dir.replace(/^"|"$/g, ''), name));
      }
    }
  }

  // 2. Where the official installers put it. VS Code does not always inherit
  //    the shell's PATH (macOS apps started from the Dock, for one), so these
  //    are checked directly rather than trusted to be on it.
  const known = isWindows
    ? [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, '.claude', 'local', 'claude.exe'),
        path.join(home, '.claude', 'local', 'claude.cmd'),
        path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        path.join(home, '.npm-global', 'bin', 'claude'),
        path.join(home, '.bun', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        '/usr/bin/claude',
      ];
  candidates.push(...known);

  // 3. The copy inside the Claude Code VS Code extension
  for (const root of bundledRoots) {
    const dir = path.join(root, 'resources', 'native-binary');
    candidates.push(path.join(dir, isWindows ? 'claude.exe' : 'claude'));
    try {
      for (const file of fs.readdirSync(dir)) {
        if (/^claude/i.test(file)) {
          candidates.push(path.join(dir, file));
        }
      }
    } catch {
      /* layout differs in this version - the fixed name above still stands */
    }
  }

  const seen = new Set<string>();
  const found: string[] = [];
  for (const candidate of candidates) {
    const key = isWindows ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    try {
      if (fs.statSync(candidate).isFile()) {
        found.push(candidate);
      }
    } catch {
      /* not there */
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/** Run one probe with the given executable and interpret what it prints. */
export function runUsageProbe(executable: string, now: () => Date = () => new Date()): Promise<UsageProbeResult> {
  const isWindows = process.platform === 'win32';
  // A .cmd shim (npm install on Windows) cannot be started without a shell.
  // cmd.exe does not understand the JSON quoting of --settings, so in that one
  // case the settings travel as a file instead.
  const needsShell = isWindows && /\.(cmd|bat)$/i.test(executable);

  let settingsArg = PROBE_SETTINGS;
  if (needsShell) {
    const file = path.join(os.tmpdir(), 'claude-statusbar-probe-settings.json');
    try {
      fs.writeFileSync(file, PROBE_SETTINGS, 'utf8');
      settingsArg = file;
    } catch {
      settingsArg = '';
    }
  }

  const args = [...PROBE_ARGS, ...(settingsArg ? ['--settings', settingsArg] : [])];
  const quote = (s: string) => (needsShell ? `"${s}"` : s);

  return new Promise((resolve) => {
    execFile(
      quote(executable),
      args.map(quote),
      {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        shell: needsShell,
        // Any neutral folder: nothing project-specific is wanted, and a probe
        // must never pick up the settings of whatever workspace is open.
        cwd: os.tmpdir(),
        maxBuffer: 4 * 1024 * 1024,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable
        env: { ...process.env, NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        const at = now();
        if (error && !stdout) {
          const reason = (error as { killed?: boolean }).killed
            ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s`
            : error.message;
          resolve({
            kind: 'failed',
            at,
            executable,
            detail: `${reason}${stderr ? ` | ${String(stderr).trim().slice(0, 500)}` : ''}`,
          });
          return;
        }
        resolve({ ...interpretProbeOutput(String(stdout), at), executable });
      }
    );
  });
}

/**
 * Make sense of what `claude -p /usage --output-format json` printed.
 * Exported for testing.
 */
export function interpretProbeOutput(stdout: string, at: Date): UsageProbeResult {
  let text = stdout;
  const json = extractJson(stdout);

  if (json) {
    // If /usage ever reaches the model, it answers ABOUT /usage and charges for
    // it. Whatever it says must not be read as the user's limits.
    const cost = typeof json.total_cost_usd === 'number' ? json.total_cost_usd : 0;
    const turns = typeof json.num_turns === 'number' ? json.num_turns : 0;
    if (cost > 0 || turns > 0) {
      return {
        kind: 'charged',
        at,
        detail: `/usage was answered by the model (cost ${cost} USD, ${turns} turn(s))`,
      };
    }
    if (typeof json.result !== 'string') {
      return { kind: 'failed', at, detail: 'JSON output carries no result text' };
    }
    text = json.result;
  }

  const parsed = parseUsageText(text, at);
  const summary = firstLine(text);

  if (parsed.fiveHour || parsed.sevenDay) {
    return { kind: 'limits', fiveHour: parsed.fiveHour, sevenDay: parsed.sevenDay, summary, at };
  }
  if (!text.trim()) {
    return { kind: 'failed', at, detail: 'empty output' };
  }
  if (parsed.sawUsagePercent) {
    return { kind: 'unrecognised', summary, at, detail: text.slice(0, 1000) };
  }
  return { kind: 'no-limits', summary, at, detail: text.slice(0, 1000) };
}

function extractJson(stdout: string): any {
  const trimmed = stdout.trim();
  const attempts = [trimmed];
  // Anything printed before the JSON (a warning, an update notice) is skipped
  const start = trimmed.indexOf('{');
  if (start > 0) {
    attempts.push(trimmed.slice(start));
  }
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === 'object') {
        return value;
      }
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 300) : undefined;
}

// ---------------------------------------------------------------------------
// Parsing the text
// ---------------------------------------------------------------------------

type WindowKind = 'fiveHour' | 'sevenDay' | 'scoped';

/** A line that starts a window block, and which window it is */
function classifyLabel(line: string): WindowKind | undefined {
  const label = line
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '') // bullets, box drawing, emoji
    .toLowerCase();

  const isSession =
    /^(current\s+)?session\b/.test(label) ||
    /^(current\s+)?(5|five)[\s-]*(h|hr|hour)s?\b/.test(label);
  const isWeek =
    /^(current\s+)?week\b/.test(label) ||
    /^weekly\b/.test(label) ||
    /^(current\s+)?(7|seven)[\s-]*(d|day)s?\b/.test(label);

  if (!isSession && !isWeek) {
    return undefined;
  }
  if (isSession) {
    return 'fiveHour';
  }

  // "Current week (all models)" is the account-wide window; "Current week
  // (Fable)" / "(Sonnet only)" are model-scoped and must not stand in for it.
  const head = label.split(/[:·]/)[0];
  const scope = head.match(/\(([^)]*)\)/)?.[1] ?? head.replace(/^(current\s+)?(weekly|week|(7|seven)[\s-]*(days?|d))\s*/, '');
  if (!scope.trim() || /\ball\b/.test(scope) || /^(limit|usage|window)s?$/.test(scope.trim())) {
    return 'sevenDay';
  }
  return 'scoped';
}

/** "22% used" -> 22, "78% left" -> 22 */
function findPercent(block: string): number | undefined {
  const match = block.match(/(\d{1,3}(?:[.,]\d+)?)\s*%\s*(used|left|remaining|available)?/i);
  if (!match) {
    return undefined;
  }
  const value = parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(value) || value < 0 || value > 1000) {
    return undefined;
  }
  const remaining = /left|remaining|available/i.test(match[2] || '');
  return Math.max(0, Math.min(100, remaining ? 100 - value : value));
}

function findResetText(block: string): string | undefined {
  const match = block.match(/\breset(?:s|ting)?\b\s*(?:at|on|by)?\s*:?\s*([^\n]+)/i);
  return match ? match[1].trim() : undefined;
}

export interface ParsedUsageText {
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
  /** Something that looked like "12% used" was seen, attributed or not */
  sawUsagePercent: boolean;
}

/**
 * Pull the account-wide 5-hour and weekly windows out of /usage text.
 *
 * Handles both the one-line layout printed by `claude -p`:
 *   Current session: 22% used · resets Sep 25, 11:39am (Europe/Warsaw)
 * and the multi-line layout of the interactive dialog:
 *   Current session
 *   ███████▌   22% used
 *   Resets 11:39am (Europe/Warsaw)
 *
 * Exported for testing.
 */
export function parseUsageText(text: string, now: Date): ParsedUsageText {
  const lines = text.split(/\r?\n/);
  const blocks: { kind: WindowKind; text: string }[] = [];
  let current: { kind: WindowKind; text: string } | undefined;

  for (const line of lines) {
    const kind = classifyLabel(line);
    if (kind) {
      current = { kind, text: line };
      blocks.push(current);
      continue;
    }
    if (!line.trim()) {
      current = undefined; // a blank line closes the block
      continue;
    }
    if (current) {
      current.text += `\n${line}`;
    }
  }

  const result: ParsedUsageText = {
    sawUsagePercent: /\d\s*%\s*(used|left|remaining)/i.test(text),
  };

  for (const block of blocks) {
    if (block.kind === 'scoped' || result[block.kind]) {
      continue; // first account-wide block of each kind wins
    }
    const usedPercent = findPercent(block.text);
    if (usedPercent === undefined) {
      continue;
    }
    const resetText = findResetText(block.text);
    const resetsAt = resetText ? parseResetTime(resetText, now) : undefined;
    const horizon = block.kind === 'fiveHour' ? 5 * 3600_000 : 7 * 86_400_000;
    // A reset in the past, or further away than the window is long, is a
    // misreading - better no window than a wrong countdown.
    if (
      !resetsAt ||
      resetsAt.getTime() < now.getTime() - 5 * 60_000 ||
      resetsAt.getTime() > now.getTime() + horizon + 3600_000
    ) {
      continue;
    }
    result[block.kind] = { usedPercent, resetsAt, approximateReset: true };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reset times
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Offset of `timeZone` from UTC at `instant`, in ms */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Wall-clock time in `timeZone` (or local time) -> instant */
function wallTimeToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string | undefined
): Date {
  if (!timeZone) {
    return new Date(year, month, day, hour, minute);
  }
  const guess = Date.UTC(year, month, day, hour, minute);
  // Twice, so a guess on the far side of a DST change settles on the right offset
  let instant = guess - zoneOffsetMs(guess, timeZone);
  instant = guess - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

/** Calendar date of `instant` in `timeZone` (or local time) */
function calendarDate(instant: Date, timeZone: string | undefined): { year: number; month: number; day: number; weekday: number } {
  if (!timeZone) {
    return {
      year: instant.getFullYear(),
      month: instant.getMonth(),
      day: instant.getDate(),
      weekday: instant.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')) - 1,
    day: Number(get('day')),
    weekday: WEEKDAYS.indexOf(get('weekday').slice(0, 3).toLowerCase()),
  };
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn the text after "resets" into an instant. Returns undefined when nothing
 * in it can be read as a time. Exported for testing.
 *
 * Understood, alone or combined:
 *   11:39am, 11:39 AM, 12pm, 23:40, noon, midnight
 *   Sep 25 / 25 Sep / September 25th / 2026-09-25 / 25.09 / 9/25, optional year
 *   Mon / Monday, today, tomorrow
 *   in 3h 20m / in 2 days / 45 min
 *   2026-09-25T09:39:59Z (ISO, with or without zone)
 *   (Europe/Warsaw) / (UTC) - the zone the wall time is in; local time otherwise
 */
export function parseResetTime(input: string, now: Date): Date | undefined {
  let text = input.trim();

  // ISO timestamps carry everything they need
  const iso = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const value = Date.parse(iso[0].replace(' ', 'T'));
    if (Number.isFinite(value)) {
      return new Date(value);
    }
  }

  // Time zone in brackets, IANA or UTC/GMT
  let timeZone: string | undefined;
  const zone = text.match(/\(\s*([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT|Etc\/[A-Za-z0-9+-]+)\s*\)/);
  if (zone) {
    const candidate = zone[1] === 'GMT' ? 'UTC' : zone[1];
    if (isValidTimeZone(candidate)) {
      timeZone = candidate;
    }
    text = text.replace(zone[0], ' ');
  }
  const lower = text.toLowerCase();

  // Relative: "in 3h 20m", "2 days 4 hours", "45 min"
  const hasClock = /\d\s*(?:am|pm|a\.m\.|p\.m\.)|\d:\d{2}|\bnoon\b|\bmidnight\b/.test(lower);
  const hasCalendar = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\b`).test(lower) || /\d{4}-\d{2}-\d{2}/.test(lower);
  if (!hasClock && !hasCalendar) {
    let total = 0;
    let matched = false;
    const unit = /(\d+(?:[.,]\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?)\b/g;
    for (const m of lower.matchAll(unit)) {
      const value = parseFloat(m[1].replace(',', '.'));
      const u = m[2];
      total += u.startsWith('d') ? value * 86_400_000 : u.startsWith('h') ? value * 3600_000 : value * 60_000;
      matched = true;
    }
    if (matched) {
      return new Date(now.getTime() + total);
    }
  }

  // Clock time
  let hour: number | undefined;
  let minute = 0;
  const twelve = lower.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  const twentyFour = lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (twelve) {
    hour = Number(twelve[1]) % 12;
    minute = twelve[2] ? Number(twelve[2]) : 0;
    if (twelve[3].startsWith('p')) {
      hour += 12;
    }
  } else if (twentyFour) {
    hour = Number(twentyFour[1]);
    minute = Number(twentyFour[2]);
  } else if (/\bnoon\b/.test(lower)) {
    hour = 12;
  } else if (/\bmidnight\b/.test(lower)) {
    hour = 0;
  }
  if (hour !== undefined && (hour > 23 || minute > 59)) {
    hour = undefined;
  }

  // Calendar date
  const today = calendarDate(now, timeZone);
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let weekday: number | undefined;

  const monthName = MONTHS.join('|');
  const monthFirst = lower.match(new RegExp(`\\b(${monthName})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`));
  const dayFirst = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthName})[a-z]*\\.?(?:,?\\s+(\\d{4}))?`));
  const isoDate = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const numeric = lower.match(/\b(\d{1,2})([./])(\d{1,2})(?:\2(\d{2,4}))?\b/);

  if (monthFirst) {
    month = MONTHS.indexOf(monthFirst[1]);
    day = Number(monthFirst[2]);
    year = monthFirst[3] ? Number(monthFirst[3]) : undefined;
  } else if (dayFirst) {
    day = Number(dayFirst[1]);
    month = MONTHS.indexOf(dayFirst[2]);
    year = dayFirst[3] ? Number(dayFirst[3]) : undefined;
  } else if (isoDate) {
    year = Number(isoDate[1]);
    month = Number(isoDate[2]) - 1;
    day = Number(isoDate[3]);
  } else if (numeric) {
    // "25.09" is day-first; "9/25" is month-first unless that is impossible
    const a = Number(numeric[1]);
    const b = Number(numeric[3]);
    const monthFirstOrder = numeric[2] === '/' && a <= 12;
    day = monthFirstOrder ? b : a;
    month = (monthFirstOrder ? a : b) - 1;
    if (numeric[4]) {
      year = Number(numeric[4]);
      if (year < 100) {
        year += 2000;
      }
    }
  } else if (/\btomorrow\b/.test(lower)) {
    const t = calendarDate(new Date(now.getTime() + 86_400_000), timeZone);
    ({ year, month, day } = t);
  } else if (/\btoday\b|\btonight\b/.test(lower)) {
    ({ year, month, day } = today);
  } else {
    const wd = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
    if (wd) {
      weekday = WEEKDAYS.indexOf(wd[1]);
    }
  }

  if (month !== undefined && (month < 0 || month > 11 || !day || day > 31)) {
    return undefined;
  }
  if (hour === undefined && day === undefined && weekday === undefined) {
    return undefined;
  }

  const h = hour ?? 0;

  if (weekday !== undefined) {
    const ahead = (weekday - today.weekday + 7) % 7;
    const target = calendarDate(new Date(now.getTime() + ahead * 86_400_000), timeZone);
    let result = wallTimeToDate(target.year, target.month, target.day, h, minute, timeZone);
    if (result.getTime() < now.getTime() - 60_000) {
      const next = calendarDate(new Date(result.getTime() + 7 * 86_400_000), timeZone);
      result = wallTimeToDate(next.year, next.month, next.day, h, minute, timeZone);
    }
    return result;
  }

  if (day === undefined || month === undefined) {
    // Clock time only: the next time the clock shows it
    let result = wallTimeToDate(today.year, today.month, today.day, h, minute, timeZone);
    if (result.getTime() < now.getTime() - 60_000) {
      const next = calendarDate(new Date(now.getTime() + 86_400_000), timeZone);
      result = wallTimeToDate(next.year, next.month, next.day, h, minute, timeZone);
    }
    return result;
  }

  if (year !== undefined) {
    return wallTimeToDate(year, month, day, h, minute, timeZone);
  }
  // No year: this year, unless that lands well in the past (a December date
  // read in January belongs to the year that is ending, and vice versa)
  let result = wallTimeToDate(today.year, month, day, h, minute, timeZone);
  if (result.getTime() < now.getTime() - 86_400_000 * 30) {
    result = wallTimeToDate(today.year + 1, month, day, h, minute, timeZone);
  } else if (result.getTime() > now.getTime() + 86_400_000 * 300) {
    result = wallTimeToDate(today.year - 1, month, day, h, minute, timeZone);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** How often Claude Code is asked while its answers are good */
const PROBE_INTERVAL_MS = 2 * 60_000;
/** After a failure: try the next candidate soon, but back off once all failed */
const RETRY_NEXT_CANDIDATE_MS = 15_000;
const RETRY_AFTER_ALL_FAILED_MS = 5 * 60_000;
/** A manual refresh never asks more often than this */
const MIN_MANUAL_GAP_MS = 15_000;
/** Another VS Code window claiming a probe older than this is assumed dead */
const RUNNING_CLAIM_MAX_AGE_MS = PROBE_TIMEOUT_MS + 30_000;

interface SerialisedResult {
  kind: UsageProbeKind;
  at: string;
  fiveHour?: { usedPercent: number; resetsAt: string };
  sevenDay?: { usedPercent: number; resetsAt: string };
  summary?: string;
  detail?: string;
  executable?: string;
}

interface SharedProbeState {
  /** The last result any window obtained */
  result?: SerialisedResult;
  /** Set while a window is running a probe, so the others wait for it */
  runningSince?: number;
  /**
   * Executables that sent /usage to the model, keyed by path + modification
   * time: an update of the program lifts the ban, nothing else does.
   */
  charged?: string[];
}

export interface UsageProbeSchedulerOptions {
  /** Candidate executables, most preferred first - re-evaluated on every run */
  findExecutables: () => string[];
  /**
   * A file shared by every VS Code window. The windows take turns: whoever
   * probes writes the result here and the others adopt it, so ten open windows
   * still start one Claude Code process every two minutes, not ten.
   */
  stateFile: string;
  /** True while another source (a live terminal bridge) makes probing pointless */
  isRedundant?: () => boolean;
  log: (line: string) => void;
  /** Called whenever a new result is available */
  onResult: (result: UsageProbeResult) => void;
}

/**
 * Keeps the usage limits current by asking Claude Code in the background.
 */
export class UsageProbeScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastAttempt = 0;
  private nextDue = 0;
  private candidateIndex = 0;
  private latest: UsageProbeResult | undefined;
  private noExecutable = false;
  private disposed = false;

  constructor(private readonly options: UsageProbeSchedulerOptions) {}

  /** Probe now, then keep the numbers current */
  public start(): void {
    this.adoptShared();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
  }

  /** The user asked for a refresh */
  public requestNow(): void {
    if (Date.now() - this.lastAttempt >= MIN_MANUAL_GAP_MS) {
      this.nextDue = 0;
      void this.tick();
    }
  }

  /** The last result, from this window or another */
  public get result(): UsageProbeResult | undefined {
    return this.latest;
  }

  /** True until the first answer arrives - the first one can take a minute */
  public get isLoading(): boolean {
    return !this.latest && !this.noExecutable;
  }

  /** No Claude Code program could be found anywhere */
  public get executableMissing(): boolean {
    return this.noExecutable;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick(): Promise<void> {
    if (this.running || this.disposed) {
      return;
    }

    // Another window may have probed in the meantime
    this.adoptShared();
    const now = Date.now();
    if (now < this.nextDue) {
      return;
    }
    if (this.latest && this.options.isRedundant?.()) {
      this.nextDue = now + PROBE_INTERVAL_MS;
      return;
    }

    const shared = this.readShared();
    if (shared.runningSince && now - shared.runningSince < RUNNING_CLAIM_MAX_AGE_MS) {
      return; // another window is asking right now; its answer will be adopted
    }

    const charged = new Set(shared.charged ?? []);
    const candidates = this.options.findExecutables().filter((exe) => !charged.has(banKey(exe)));
    if (candidates.length === 0) {
      if (!this.noExecutable) {
        this.options.log('[Usage] No Claude Code executable found (VS Code extension or CLI)');
        this.noExecutable = true;
        this.options.onResult({ kind: 'failed', at: new Date(), detail: 'Claude Code not found' });
      }
      this.nextDue = now + RETRY_AFTER_ALL_FAILED_MS;
      return;
    }
    this.noExecutable = false;

    const executable = candidates[this.candidateIndex % candidates.length];
    this.running = true;
    this.lastAttempt = now;
    this.writeShared({ ...shared, runningSince: now });
    this.options.log(`[Usage] Asking Claude Code: ${executable}`);

    let result: UsageProbeResult;
    try {
      result = await runUsageProbe(executable);
    } catch (err) {
      result = { kind: 'failed', at: new Date(), executable, detail: String(err) };
    } finally {
      this.running = false;
    }
    if (this.disposed) {
      return;
    }

    const took = ((Date.now() - now) / 1000).toFixed(1);
    this.options.log(
      `[Usage] ${result.kind} after ${took}s` +
        (result.fiveHour ? ` | 5h ${result.fiveHour.usedPercent}%` : '') +
        (result.sevenDay ? ` | 7d ${result.sevenDay.usedPercent}%` : '') +
        (result.detail && result.kind !== 'limits' ? ` | ${result.detail.slice(0, 300)}` : '')
    );

    const state = this.readShared();
    delete state.runningSince;

    if (result.kind === 'charged') {
      // Never again with this build of the program - every call would cost money
      state.charged = [...new Set([...(state.charged ?? []), banKey(executable)])];
      this.candidateIndex++;
      this.nextDue = Date.now() + RETRY_NEXT_CANDIDATE_MS;
    } else if (result.kind === 'failed') {
      this.candidateIndex++;
      const triedAll = this.candidateIndex % candidates.length === 0;
      this.nextDue = Date.now() + (triedAll ? RETRY_AFTER_ALL_FAILED_MS : RETRY_NEXT_CANDIDATE_MS);
    } else {
      this.nextDue = Date.now() + PROBE_INTERVAL_MS;
    }

    // A failure does not replace a good answer from a moment ago: the numbers
    // it carried stay valid, and the UI dates them if the failures persist.
    const keepPrevious =
      (result.kind === 'failed' || result.kind === 'charged') && this.latest?.kind === 'limits';
    if (!keepPrevious) {
      this.latest = result;
      state.result = serialise(result);
    }
    this.writeShared(state);
    if (!keepPrevious) {
      this.options.onResult(result);
    }
  }

  /** Take over a result another window obtained */
  private adoptShared(): void {
    const shared = this.readShared().result;
    if (!shared) {
      return;
    }
    const at = Date.parse(shared.at);
    if (!Number.isFinite(at) || (this.latest && this.latest.at.getTime() >= at)) {
      return;
    }
    if (Date.now() - at > PROBE_INTERVAL_MS * 3) {
      return; // too old to show as current; probe instead
    }
    this.latest = deserialise(shared);
    this.nextDue = Math.max(this.nextDue, at + PROBE_INTERVAL_MS);
    this.options.onResult(this.latest);
  }

  private readShared(): SharedProbeState {
    try {
      const value = JSON.parse(fs.readFileSync(this.options.stateFile, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  private writeShared(state: SharedProbeState): void {
    try {
      fs.mkdirSync(path.dirname(this.options.stateFile), { recursive: true });
      const tmp = `${this.options.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, this.options.stateFile);
    } catch {
      /* sharing is an optimisation - every window can still probe on its own */
    }
  }
}

function banKey(executable: string): string {
  let mtime = 0;
  try {
    mtime = fs.statSync(executable).mtimeMs;
  } catch {
    /* gone - the key still identifies it */
  }
  return `${executable}|${mtime}`;
}

function serialise(result: UsageProbeResult): SerialisedResult {
  const win = (w?: RateLimitWindow) =>
    w ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt.toISOString() } : undefined;
  return {
    kind: result.kind,
    at: result.at.toISOString(),
    fiveHour: win(result.fiveHour),
    sevenDay: win(result.sevenDay),
    summary: result.summary,
    detail: result.detail?.slice(0, 1000),
    executable: result.executable,
  };
}

function deserialise(shared: SerialisedResult): UsageProbeResult {
  const win = (w?: { usedPercent: number; resetsAt: string }): RateLimitWindow | undefined =>
    w && typeof w.usedPercent === 'number' && Number.isFinite(Date.parse(w.resetsAt))
      ? { usedPercent: w.usedPercent, resetsAt: new Date(w.resetsAt), approximateReset: true }
      : undefined;
  return {
    kind: shared.kind,
    at: new Date(shared.at),
    fiveHour: win(shared.fiveHour),
    sevenDay: win(shared.sevenDay),
    summary: shared.summary,
    detail: shared.detail,
    executable: shared.executable,
  };
}
