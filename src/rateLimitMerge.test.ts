/**
 * Tests for the rate limit merge rule.
 *
 * Every open Claude Code session renders the status line, and each one carries
 * the rate limits IT last received from the API - so a session sitting idle
 * kept overwriting the shared snapshot with old numbers under a fresh
 * timestamp, and the displayed percentages flickered between sessions. The rule
 * that fixes it is exercised twice here: once through the pure helper the
 * extension uses when reading, and once end to end through the status line
 * script itself, driven the way Claude Code drives it.
 *
 * Run: npm run compile-tests && node out/rateLimitMerge.test.js
 */

/* eslint-disable @typescript-eslint/naming-convention -- the payload mirrors Claude Code's JSON */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { installBridge, pickCurrentWindow, readRateLimits } from './rateLimits';

const NOW = Date.now();
const IN_AN_HOUR = new Date(NOW + 3600_000);
const IN_SIX_HOURS = new Date(NOW + 6 * 3600_000);
const A_MINUTE_AGO = new Date(NOW - 60_000);

console.log('pickCurrentWindow');

assert.strictEqual(
  pickCurrentWindow({ usedPercent: 2, resetsAt: IN_AN_HOUR }, undefined, NOW)?.usedPercent,
  2,
  'the first reading is taken as it stands'
);

assert.strictEqual(
  pickCurrentWindow(
    { usedPercent: 2, resetsAt: IN_AN_HOUR },
    { usedPercent: 11, resetsAt: IN_AN_HOUR },
    NOW
  )?.usedPercent,
  11,
  'inside one window the higher reading wins - usage only grows'
);

assert.strictEqual(
  pickCurrentWindow(
    { usedPercent: 12, resetsAt: IN_AN_HOUR },
    { usedPercent: 11, resetsAt: IN_AN_HOUR },
    NOW
  )?.usedPercent,
  12,
  'real consumption still moves the number up'
);

assert.strictEqual(
  pickCurrentWindow(
    { usedPercent: 1, resetsAt: IN_SIX_HOURS },
    { usedPercent: 90, resetsAt: IN_AN_HOUR },
    NOW
  )?.usedPercent,
  1,
  'a later reset is a new window and wins outright, low as it is'
);

assert.strictEqual(
  pickCurrentWindow(
    { usedPercent: 1, resetsAt: IN_AN_HOUR },
    { usedPercent: 90, resetsAt: A_MINUTE_AGO },
    NOW
  )?.usedPercent,
  1,
  'a window that has already reset says nothing about the one running now'
);

assert.strictEqual(
  pickCurrentWindow(undefined, { usedPercent: 11, resetsAt: IN_AN_HOUR }, NOW)?.usedPercent,
  11,
  'a snapshot without windows leaves the last known reading alone'
);

assert.strictEqual(
  pickCurrentWindow(undefined, { usedPercent: 11, resetsAt: A_MINUTE_AGO }, NOW),
  undefined,
  'nothing to fall back on once the remembered window has reset'
);

console.log('  7 assertions passed');
console.log('the installed status line script');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-statusbar-bridge-'));
try {
  installBridge(dir);
  const script = path.join(dir, 'claude-statusbar-bridge.js');
  const stateFile = path.join(dir, 'claude-statusbar-bridge.json');
  const soon = Math.floor(NOW / 1000) + 3600;

  /** Drive the script exactly as Claude Code does: one render, JSON on stdin. */
  function render(sessionId: string, fiveHour: number | null): any {
    execFileSync(process.execPath, [script], {
      input: JSON.stringify({
        session_id: sessionId,
        model: { id: 'claude-opus-5', display_name: 'Opus 5' },
        context_window: { used_percentage: 5, context_window_size: 1_000_000 },
        rate_limits:
          fiveHour === null
            ? null
            : {
                five_hour: { used_percentage: fiveHour, resets_at: soon },
                seven_day: { used_percentage: fiveHour, resets_at: soon + 86_400 },
              },
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    });
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  }

  let snapshot = render('active', 11);
  assert.strictEqual(snapshot.rate_limits.five_hour.used_percentage, 11);
  const confirmedAt = snapshot.rate_limits_at;

  snapshot = render('idle', 2);
  assert.strictEqual(
    snapshot.rate_limits.five_hour.used_percentage,
    11,
    'an idle session must not drag the percentage back down'
  );
  assert.strictEqual(
    snapshot.rate_limits_at,
    confirmedAt,
    'a rejected reading must not restamp the numbers as current'
  );
  assert.ok(snapshot.written_at >= confirmedAt, 'the write itself is still dated');
  assert.strictEqual(
    snapshot.session_id,
    'idle',
    'per-session fields still follow whoever rendered last'
  );

  snapshot = render('active', 12);
  assert.strictEqual(snapshot.rate_limits.five_hour.used_percentage, 12);
  assert.ok(snapshot.rate_limits_at >= confirmedAt, 'an accepted reading restamps');

  snapshot = render('api-key-session', null);
  assert.strictEqual(
    snapshot.rate_limits.five_hour.used_percentage,
    12,
    'a login without rate limits leaves the last known ones standing'
  );

  const read = readRateLimits(dir);
  assert.strictEqual(read?.fiveHour?.usedPercent, 12, 'the extension reads the merged value');

  console.log('  8 assertions passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('all passed');
