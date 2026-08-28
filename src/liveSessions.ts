import * as fs from 'fs';
import * as path from 'path';
import { getClaudeConfigDir } from './rateLimits';

/**
 * Which Claude Code sessions are actually open right now.
 *
 * Claude Code keeps a small file per running process in `~/.claude/sessions/`,
 * named after the PID and carrying the session id, its working directory and its
 * entrypoint. The files are normally removed when a session exits, but a crash
 * leaves one behind, so the PID is checked as well - "the file exists" is not
 * the same claim as "the session is running".
 *
 * This matters because the alternative is a timeout, and a timeout is always
 * wrong in one direction: too short and a session you are still thinking about
 * disappears, too long and yesterday's work is still listed as open.
 */
export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd?: string;
  /** `cli`, `claude-vscode`, ... */
  entrypoint?: string;
  /** Name Claude Code derived for the session, e.g. `tomek-d3` */
  name?: string;
  /** `busy` while a turn is running */
  status?: string;
}

const SESSIONS_DIR = 'sessions';

/** `<pid>.json` - the directory also holds `<pid>.<hash>.key` files */
const SESSION_FILE = /^(\d+)\.json$/;

export function readLiveSessions(dir = getClaudeConfigDir()): LiveSession[] {
  const sessionsDir = path.join(dir, SESSIONS_DIR);

  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return []; // older Claude Code, or nothing has run yet
  }

  const out: LiveSession[] = [];
  for (const file of files) {
    if (!SESSION_FILE.test(file)) {
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
    } catch {
      continue;
    }

    const pid = Number(parsed.pid);
    const sessionId = parsed.sessionId;
    if (!Number.isInteger(pid) || typeof sessionId !== 'string' || !isProcessAlive(pid)) {
      continue;
    }

    out.push({
      sessionId,
      pid,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      entrypoint: typeof parsed.entrypoint === 'string' ? parsed.entrypoint : undefined,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      status: typeof parsed.status === 'string' ? parsed.status : undefined,
    });
  }

  return out;
}

/**
 * Signal 0 sends nothing; it only asks whether the process can be signalled.
 * `EPERM` means it exists but belongs to someone else, which still counts as
 * alive. Works on Windows, where the PID namespace is what we are querying.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** Directory the extension should watch for sessions opening and closing */
export function getLiveSessionsDirPath(dir = getClaudeConfigDir()): string {
  return path.join(dir, SESSIONS_DIR);
}
