/**
 * Tests for reading the usage limits out of `claude -p /usage`.
 *
 * The text is meant for people, so these pin down the variants the parser has
 * to survive: the layout Claude Code prints today, the interactive dialog's
 * multi-line layout, rounding of the reset time, 12- and 24-hour clocks, dates
 * with and without a year, relative resets, ISO stamps, "left" instead of
 * "used", model-scoped weekly windows, and accounts with no limits at all.
 *
 * Run: npm run compile-tests && node out/usageProbe.test.js
 */

/* eslint-disable @typescript-eslint/naming-convention -- the payload mirrors Claude Code's JSON */

import * as assert from 'assert';
import { interpretProbeOutput, parseResetTime, parseUsageText } from './usageProbe';
import { pickCurrentWindow } from './rateLimits';
import { RateLimitWindow } from './types';

// 10:30 in Warsaw (UTC+2 in September)
const NOW = new Date('2026-09-25T08:30:00Z');
const WAW = '(Europe/Warsaw)';
let count = 0;

function iso(date: Date | undefined): string | undefined {
  return date?.toISOString();
}

function reset(text: string, expected: string, message: string) {
  assert.strictEqual(iso(parseResetTime(text, NOW)), expected, `${message}: "${text}"`);
  count++;
}

console.log('parseResetTime');

reset(`Sep 25, 11:40am ${WAW}`, '2026-09-25T09:40:00.000Z', 'month-day with 12-hour clock');
reset(`Sep 25, 11:39am ${WAW}`, '2026-09-25T09:39:00.000Z', 'the same reset, truncated instead of rounded');
reset(`Sep 29, 12pm ${WAW}`, '2026-09-29T10:00:00.000Z', 'hour-only noon');
reset(`Sep 29, 11:59am ${WAW}`, '2026-09-29T09:59:00.000Z', 'minute before noon');
reset(`11:40am ${WAW}`, '2026-09-25T09:40:00.000Z', 'clock time only, later today');
reset(`9am ${WAW}`, '2026-09-26T07:00:00.000Z', 'clock time already past today means tomorrow');
reset(`11:40 AM ${WAW}`, '2026-09-25T09:40:00.000Z', 'upper case with a space');
reset(`11:40 a.m. ${WAW}`, '2026-09-25T09:40:00.000Z', 'dotted a.m.');
reset(`23:40 ${WAW}`, '2026-09-25T21:40:00.000Z', '24-hour clock');
reset(`25 Sep, 23:40 ${WAW}`, '2026-09-25T21:40:00.000Z', 'day-first with 24-hour clock');
reset(`September 29th at 12:00 PM ${WAW}`, '2026-09-29T10:00:00.000Z', 'long month and ordinal');
reset(`Sep 29, 2026, 12:00 PM ${WAW}`, '2026-09-29T10:00:00.000Z', 'with a year');
reset(`29.09 12:00 ${WAW}`, '2026-09-29T10:00:00.000Z', 'dotted day.month');
reset(`9/29 12:00 PM ${WAW}`, '2026-09-29T10:00:00.000Z', 'US month/day');
reset(`2026-09-29 12:00 ${WAW}`, '2026-09-29T10:00:00.000Z', 'ISO date with wall time and a zone');
reset('2026-09-29T09:59:59.768845+00:00', '2026-09-29T09:59:59.768Z', 'ISO timestamp');
reset(`Tue 12pm ${WAW}`, '2026-09-29T10:00:00.000Z', 'weekday');
reset(`Tuesday at noon ${WAW}`, '2026-09-29T10:00:00.000Z', 'weekday spelled out, noon');
reset(`tomorrow at 9:00am ${WAW}`, '2026-09-26T07:00:00.000Z', 'tomorrow');
reset('in 3h 20m', '2026-09-25T11:50:00.000Z', 'relative hours and minutes');
reset('in 2 days 4 hours', '2026-09-27T12:30:00.000Z', 'relative days and hours');
reset('45 min', '2026-09-25T09:15:00.000Z', 'relative minutes');
reset('Sep 29, 12pm (UTC)', '2026-09-29T12:00:00.000Z', 'UTC zone');
reset('Oct 25, 12pm (Europe/Warsaw)', '2026-10-25T11:00:00.000Z', 'after the DST change the offset is +1');
reset('Jan 2, 12pm (UTC)', '2027-01-02T12:00:00.000Z', 'a date well past belongs to next year');
assert.strictEqual(parseResetTime('soon', NOW), undefined, 'nothing readable');
count++;
assert.ok(parseResetTime('Sep 29, 12pm (Mars/Olympus)', NOW), 'an unknown zone falls back to local time');
count++;
console.log(`  ${count} assertions passed`);

console.log('parseUsageText');
let before = count;

const CURRENT = `You are currently using your subscription to power your Claude Code usage

Current session: 22% used · resets Sep 25, 11:39am (Europe/Warsaw)
Current week (all models): 70% used · resets Sep 29, 11:59am (Europe/Warsaw)
Current week (Fable): 2% used · resets Sep 29, 11:59am (Europe/Warsaw)

What's contributing to your limits usage?
Last 24h · 3762 requests · 11 sessions
  92% of your usage came from sessions active for 8+ hours
Last 7d · 44981 requests · 29 sessions
  95% of your usage came from subagent-heavy sessions`;

let parsed = parseUsageText(CURRENT, NOW);
assert.strictEqual(parsed.fiveHour?.usedPercent, 22, 'session percentage');
assert.strictEqual(iso(parsed.fiveHour?.resetsAt), '2026-09-25T09:39:00.000Z', 'session reset');
assert.strictEqual(parsed.sevenDay?.usedPercent, 70, 'the all-models week, not the Fable one');
assert.strictEqual(iso(parsed.sevenDay?.resetsAt), '2026-09-29T09:59:00.000Z', 'week reset');
assert.strictEqual(parsed.fiveHour?.approximateReset, true, 'text resets are marked approximate');
count += 5;

// The interactive dialog: label, bar, then the reset on its own line
const DIALOG = `Current session
█████████▌                                         19% used
Resets 11:40am (Europe/Warsaw)

Current week (all models)
███████████████████████████████████▌               69% used
Resets Sep 29, 12pm (Europe/Warsaw)

Current week (Sonnet only)
▌                                                  1% used
Resets Sep 29, 12pm (Europe/Warsaw)`;

parsed = parseUsageText(DIALOG, NOW);
assert.strictEqual(parsed.fiveHour?.usedPercent, 19, 'multi-line session');
assert.strictEqual(iso(parsed.fiveHour?.resetsAt), '2026-09-25T09:40:00.000Z', 'multi-line session reset');
assert.strictEqual(parsed.sevenDay?.usedPercent, 69, 'multi-line week ignores the Sonnet-only window');
count += 3;

// Scoped week listed first must not stand in for the account-wide one
parsed = parseUsageText(
  `Current week (Opus): 90% used · resets Sep 29, 12pm ${WAW}\nCurrent week: 40% used · resets Sep 29, 12pm ${WAW}`,
  NOW
);
assert.strictEqual(parsed.sevenDay?.usedPercent, 40, 'unscoped week after a scoped one');
count++;

// Wording that may change
parsed = parseUsageText(
  `5-hour limit: 78% left, resets in 1h 10m\nWeekly limit: 25.5% used — resets on Tue 12:00 ${WAW}`,
  NOW
);
assert.strictEqual(parsed.fiveHour?.usedPercent, 22, '"left" is turned into "used"');
assert.strictEqual(iso(parsed.fiveHour?.resetsAt), '2026-09-25T09:40:00.000Z', 'relative reset');
assert.strictEqual(parsed.sevenDay?.usedPercent, 25.5, 'decimal percentage');
count += 3;

parsed = parseUsageText(`• Session: 5 % used (resets 11:40am ${WAW})`, NOW);
assert.strictEqual(parsed.fiveHour?.usedPercent, 5, 'bullet, spaced percent, reset in brackets');
count++;

// A reset that cannot be right is not trusted
parsed = parseUsageText(`Current session: 22% used · resets Sep 30, 11:39am ${WAW}`, NOW);
assert.strictEqual(parsed.fiveHour, undefined, 'a 5-hour window cannot reset five days from now');
count++;

parsed = parseUsageText('Current session: 22% used', NOW);
assert.strictEqual(parsed.fiveHour, undefined, 'no reset, no window');
assert.strictEqual(parsed.sawUsagePercent, true, 'but a percentage was seen');
count += 2;

console.log(`  ${count - before} assertions passed`);

console.log('interpretProbeOutput');
before = count;

const json = (result: string, extra: object = {}) =>
  JSON.stringify({ type: 'result', total_cost_usd: 0, num_turns: 0, result, ...extra });

let out = interpretProbeOutput(json(CURRENT), NOW);
assert.strictEqual(out.kind, 'limits');
assert.strictEqual(out.sevenDay?.usedPercent, 70);
count += 2;

out = interpretProbeOutput(`Update available!\n${json(CURRENT)}`, NOW);
assert.strictEqual(out.kind, 'limits', 'text printed before the JSON is skipped');
count++;

out = interpretProbeOutput(CURRENT, NOW);
assert.strictEqual(out.kind, 'limits', 'plain text output is read too');
count++;

out = interpretProbeOutput(
  json('You are currently using API usage billing. /usage is only available for subscription plans.'),
  NOW
);
assert.strictEqual(out.kind, 'no-limits', 'an API-key account');
assert.ok(out.summary?.includes('API usage billing'), 'Claude Code’s own words are kept');
count += 2;

out = interpretProbeOutput(json('It looks like you typed /usage…', { total_cost_usd: 0.11, num_turns: 1 }), NOW);
assert.strictEqual(out.kind, 'charged', 'an answer from the model is never read as limits');
count++;

out = interpretProbeOutput(json('Session usage 22% used, week 70% used'), NOW);
assert.strictEqual(out.kind, 'unrecognised', 'percentages without recognisable windows');
count++;

out = interpretProbeOutput('', NOW);
assert.strictEqual(out.kind, 'failed');
count++;

console.log(`  ${count - before} assertions passed`);

console.log('merging /usage with the bridge');
before = count;

const bridge: RateLimitWindow = { usedPercent: 18, resetsAt: new Date('2026-09-25T09:40:00Z') };
const probe: RateLimitWindow = { usedPercent: 19, resetsAt: new Date('2026-09-25T09:39:00Z'), approximateReset: true };
let merged = pickCurrentWindow(probe, bridge, NOW.getTime());
assert.strictEqual(merged?.usedPercent, 19, 'a rounded reset is still the same window: higher wins');
assert.strictEqual(iso(merged?.resetsAt), '2026-09-25T09:40:00.000Z', 'the precise reset is kept');
count += 2;

merged = pickCurrentWindow(
  { usedPercent: 17, resetsAt: new Date('2026-09-25T10:00:00Z'), approximateReset: true },
  bridge,
  NOW.getTime()
);
assert.strictEqual(merged?.usedPercent, 18, 'an hour-rounded reset does not start a new window');
count++;

merged = pickCurrentWindow(
  { usedPercent: 1, resetsAt: new Date('2026-09-25T14:40:00Z'), approximateReset: true },
  bridge,
  NOW.getTime()
);
assert.strictEqual(merged?.usedPercent, 1, 'five hours later is a new window');
count++;

console.log(`  ${count - before} assertions passed`);
console.log('');
console.log(`all ${count} passed`);
