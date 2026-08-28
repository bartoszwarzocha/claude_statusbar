import * as path from 'path';
import { SessionContextInfo, TranscriptMeta } from './types';
import { SessionContext } from './rateLimits';
import { LiveSession } from './liveSessions';

/**
 * Building the list of open Claude Code sessions.
 *
 * Two sources feed it and neither is sufficient alone:
 *
 *  - the bridge (`claude-statusbar-sessions/`) carries Claude Code's own context
 *    percentage, but only for sessions that render a status line. The VS Code
 *    extension has no status line, so its sessions never appear there;
 *  - transcripts cover every session regardless of entrypoint, but only say how
 *    many tokens the last reply carried, not what fraction of the window that is.
 *
 * So transcripts decide *which* sessions exist and the bridge refines *their*
 * numbers where it has them.
 */

/**
 * Fallback cut-off, used only when Claude Code publishes no live-session files
 * (versions before they existed). Every timeout is wrong in one direction, so
 * this is deliberately the second choice - see liveSessions.ts.
 */
const MAX_IDLE_MS = 2 * 60 * 60 * 1000;

/** Enough rows to see what is running without turning the panel into a log */
const MAX_ROWS = 8;

/**
 * Denominators used when Claude Code has never told us the real window size,
 * which only happens when the bridge has never run at all.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;

/**
 * A bridge reading counts as current only while it is at least as recent as the
 * transcript. A session that started in the terminal and moved into the VS Code
 * extension keeps its last status line reading for hours; the transcript is then
 * the only thing still moving, and the stale percentage must not win.
 */
const BRIDGE_TOLERANCE_MS = 60 * 1000;

export function buildSessionContexts(
  transcripts: TranscriptMeta[],
  bridgeRows: SessionContext[],
  /** `context_window_size` last reported by Claude Code, at any age */
  knownWindowSize?: number,
  /** Sessions Claude Code currently has running; empty means "unknown" */
  liveSessions: LiveSession[] = [],
  now: number = Date.now()
): SessionContextInfo[] {
  const byBridge = new Map<string, SessionContext>();
  for (const row of bridgeRows) {
    byBridge.set(row.sessionId, row);
  }

  const live = new Map<string, LiveSession>();
  for (const session of liveSessions) {
    live.set(session.sessionId, session);
  }
  // An empty set means Claude Code told us nothing, not that nothing is running.
  const trustLiveSet = live.size > 0;
  const isOpen = (sessionId: string, lastActivity: Date) =>
    trustLiveSet ? live.has(sessionId) : now - lastActivity.getTime() <= MAX_IDLE_MS;

  const out: SessionContextInfo[] = [];
  const seen = new Set<string>();

  for (const meta of transcripts) {
    const sessionId = meta.sessionId;
    const lastActivity = meta.lastActivity;
    if (!sessionId || !lastActivity || !isOpen(sessionId, lastActivity)) {
      continue;
    }
    seen.add(sessionId);

    const bridge = byBridge.get(sessionId);
    const bridgeIsCurrent =
      !!bridge &&
      typeof bridge.contextPercent === 'number' &&
      bridge.updatedAt.getTime() >= lastActivity.getTime() - BRIDGE_TOLERANCE_MS;

    const windowSize =
      bridge?.contextWindowSize ?? knownWindowSize ?? guessWindowSize(meta.contextTokens);

    const estimatedPercent =
      meta.contextTokens !== undefined && windowSize > 0
        ? (meta.contextTokens / windowSize) * 100
        : undefined;

    out.push({
      sessionId,
      label: labelFor(meta, bridge, live.get(sessionId)),
      contextPercent: bridgeIsCurrent ? bridge!.contextPercent : estimatedPercent,
      contextTokens: meta.contextTokens,
      contextWindowSize: windowSize,
      model: meta.model || bridge?.model,
      title: meta.title || bridge?.title,
      entrypoint: live.get(sessionId)?.entrypoint || meta.entrypoint,
      estimated: !bridgeIsCurrent && estimatedPercent !== undefined,
      updatedAt: lastActivity,
    });
  }

  // A bridge row without a transcript should not happen, but dropping a session
  // Claude Code is actively reporting would be the worse failure.
  for (const row of bridgeRows) {
    if (seen.has(row.sessionId) || (trustLiveSet && !live.has(row.sessionId))) {
      continue;
    }
    out.push({
      sessionId: row.sessionId,
      label: row.label,
      contextPercent: row.contextPercent,
      contextWindowSize: row.contextWindowSize,
      model: row.model,
      title: row.title,
      updatedAt: row.updatedAt,
    });
  }

  return out
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, MAX_ROWS);
}

/**
 * The project folder is the most recognisable label: short, stable, and how the
 * work is actually organised. The conversation title is a sentence that would be
 * truncated inline, so it becomes hover text instead.
 */
function labelFor(meta: TranscriptMeta, bridge?: SessionContext, live?: LiveSession): string {
  const cwd = meta.cwd || live?.cwd;
  if (cwd) {
    const base = path.basename(cwd);
    if (base) {
      return base;
    }
  }
  return bridge?.label || meta.title || (meta.sessionId || '').slice(0, 8);
}

/**
 * Only reached when the bridge has never run. Claude Code offers both a 200k and
 * a 1M window, and nothing on disk says which one a session got, so the observed
 * usage is the only evidence available: more than 200k tokens resident proves
 * the larger window.
 */
function guessWindowSize(contextTokens?: number): number {
  return contextTokens !== undefined && contextTokens > DEFAULT_CONTEXT_WINDOW
    ? LARGE_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW;
}
