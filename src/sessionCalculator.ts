import * as vscode from 'vscode';
import { ClaudeMessage, SessionMetrics, PlanConfig } from './types';
import { calculateLimitTokens } from './sessionParser';
import { calculateMessageCost, getModelTier } from './pricing';

const SESSION_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds
const BURN_RATE_WINDOW_MS = 10 * 60 * 1000; // Last 10 minutes for burn rate

/**
 * Round timestamp to nearest full hour in UTC
 * Logic from Maciek-roboblog/Claude-Code-Usage-Monitor
 */
function roundToNearestHour(date: Date): Date {
  const rounded = new Date(date);
  rounded.setMinutes(0, 0, 0);
  return rounded;
}

/**
 * Group messages into 5-hour session sets
 * Logic from Claude Code Usage Monitor (Maciek-roboblog):
 * - Start time ROUNDED to nearest full hour in UTC
 * - Session lasts 5 hours from rounded start
 * - New session begins when: timestamp > end_time OR gap between messages >= 5h
 */
interface SessionSet {
  startTime: Date;
  endTime: Date;
  lastMessageTime: Date;
  messages: ClaudeMessage[];
}

function groupIntoFiveHourSets(messages: ClaudeMessage[]): SessionSet[] {
  if (messages.length === 0) {
    return [];
  }

  const sets: SessionSet[] = [];
  let currentSet: SessionSet | null = null;

  for (const message of messages) {
    const msgTime = new Date(message.timestamp);

    if (!currentSet) {
      // Start first set from rounded hour of first message
      const roundedStart = roundToNearestHour(msgTime);
      currentSet = {
        startTime: roundedStart,
        endTime: new Date(roundedStart.getTime() + SESSION_DURATION_MS),
        lastMessageTime: msgTime,
        messages: [message],
      };
    } else {
      // Check if we need a new block (exact Python logic from analyzer.py)
      if (msgTime >= currentSet.endTime) {
        // Message is at or past end time - start new block
        sets.push(currentSet);

        const roundedStart = roundToNearestHour(msgTime);
        currentSet = {
          startTime: roundedStart,
          endTime: new Date(roundedStart.getTime() + SESSION_DURATION_MS),
          lastMessageTime: msgTime,
          messages: [message],
        };
        continue;
      }

      // Check gap between this message and last message in set
      const timeSinceLastMessage = msgTime.getTime() - currentSet.lastMessageTime.getTime();

      // New session if: gap >= 5 hours
      if (currentSet.messages.length > 0 && timeSinceLastMessage >= SESSION_DURATION_MS) {
        // Save current and start new set
        sets.push(currentSet);

        const roundedStart = roundToNearestHour(msgTime);
        currentSet = {
          startTime: roundedStart,
          endTime: new Date(roundedStart.getTime() + SESSION_DURATION_MS),
          lastMessageTime: msgTime,
          messages: [message],
        };
      } else {
        // Message belongs to current set
        currentSet.messages.push(message);
        currentSet.lastMessageTime = msgTime;
      }
    }
  }

  // Add the last set
  if (currentSet) {
    sets.push(currentSet);
  }

  return sets;
}

/**
 * Calculate session metrics from ALL messages across all files
 */
export function calculateSessionMetrics(
  messages: ClaudeMessage[],
  sessionId: string,
  planConfig: PlanConfig,
  outputChannel?: vscode.OutputChannel
): SessionMetrics | null {
  if (messages.length === 0) {
    return null;
  }

  const now = new Date();

  // Step 1: Remove duplicate messages using both ID and requestId (like Python does)
  // Python creates hash as: f"{message_id}:{request_id}" and keeps FIRST occurrence
  // IMPORTANT: Keep FIRST occurrence, not last (messages are streaming updates)
  const seenHashes = new Set<string>();
  const uniqueMessages: ClaudeMessage[] = [];
  for (const m of messages) {
    const hash = `${m.id}:${m.requestId}`;
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      uniqueMessages.push(m);
    }
  }

  outputChannel?.appendLine(`Total messages: ${messages.length}, Unique: ${uniqueMessages.length}`);

  // Step 2: Sort all messages by timestamp
  const sortedMessages = [...uniqueMessages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Step 3: Filter to last 192 hours (8 days) like Python does
  const HOURS_BACK = 192;
  const cutoffTime = new Date(now.getTime() - HOURS_BACK * 60 * 60 * 1000);

  const recentMessages = sortedMessages.filter((msg) => {
    const msgTime = new Date(msg.timestamp);
    return msgTime >= cutoffTime;
  });

  outputChannel?.appendLine(`Sorted: ${sortedMessages.length}, Recent messages (last ${HOURS_BACK}h): ${recentMessages.length}`);

  if (recentMessages.length === 0) {
    return null; // No recent messages
  }

  // Step 4: Group into 5-hour sets starting from the very first recent message
  const sets = groupIntoFiveHourSets(recentMessages);

  outputChannel?.appendLine('');
  outputChannel?.appendLine(`Created ${sets.length} session sets:`);
  sets.forEach((set, i) => {
    const setTokens = set.messages.reduce((sum, msg) =>
      sum + (msg.usage ? calculateLimitTokens(msg.usage) : 0), 0
    );
    outputChannel?.appendLine(
      `  Set ${i + 1}: ${set.startTime.toLocaleTimeString()} - ${set.endTime.toLocaleTimeString()} (${set.messages.length} msgs, ${setTokens} tokens)`
    );
  });

  if (sets.length === 0) {
    return null;
  }

  // Step 5: Find the last set that overlaps with current time
  // A set overlaps if current time is between startTime and endTime
  const activeSets = sets.filter((set) => {
    return now >= set.startTime && now <= set.endTime;
  });

  outputChannel?.appendLine('');
  outputChannel?.appendLine(`Current time: ${now.toLocaleTimeString()}`);
  outputChannel?.appendLine(`Active sets found: ${activeSets.length}`);

  // Get the last (most recent) overlapping set
  const activeSet = activeSets.length > 0 ? activeSets[activeSets.length - 1] : null;

  if (!activeSet) {
    outputChannel?.appendLine('WARNING: No active session set found');
    return null; // No active session - all sets have expired
  }

  outputChannel?.appendLine('');
  outputChannel?.appendLine(`ACTIVE SET SELECTED:`);
  outputChannel?.appendLine(`  Start: ${activeSet.startTime.toLocaleTimeString()}`);
  outputChannel?.appendLine(`  End: ${activeSet.endTime.toLocaleTimeString()}`);
  outputChannel?.appendLine(`  Messages: ${activeSet.messages.length}`);

  const sessionMessages = activeSet.messages;
  const startTime = activeSet.startTime;
  const lastMessageTime = activeSet.lastMessageTime;
  const sessionEndTime = activeSet.endTime;
  const timeRemaining = Math.max(0, sessionEndTime.getTime() - now.getTime());
  const isActive = timeRemaining > 0;

  // Calculate token totals and costs for messages in this window
  let totalTokens = 0;
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;
  let messageCount = 0;

  // Breakdown by model tier
  const modelBreakdown = {
    opus: 0,
    sonnet: 0,
    haiku: 0,
  };

  // Breakdown by project
  const projectBreakdown: Record<string, number> = {};

  const seenIds = new Set<string>();

  outputChannel?.appendLine('');
  outputChannel?.appendLine('ITERATING THROUGH SESSION MESSAGES:');

  for (const message of sessionMessages) {
    if (message.usage) {
      // Skip duplicates (using same hash as Python: message_id:request_id)
      const uniqueHash = `${message.id}:${message.requestId}`;
      if (seenIds.has(uniqueHash)) {
        outputChannel?.appendLine(`  SKIPPED (duplicate): ${message.id.substring(0, 8)}...`);
        continue;
      }
      seenIds.add(uniqueHash);

      messageCount++;
      const msgTokens = calculateLimitTokens(message.usage);
      totalTokens += msgTokens;
      inputTokens += message.usage.input_tokens;
      cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
      cacheReadTokens += message.usage.cache_read_input_tokens || 0;
      outputTokens += message.usage.output_tokens;

      const msgCost = calculateMessageCost(message.usage, message.model);
      totalCost += msgCost;

      // Aggregate by model tier
      const modelTier = getModelTier(message.model);
      modelBreakdown[modelTier] += msgTokens;

      // Aggregate by project
      if (message.projectName) {
        projectBreakdown[message.projectName] = (projectBreakdown[message.projectName] || 0) + msgTokens;
      }

      outputChannel?.appendLine(
        `  Msg ${messageCount}: ${message.id.substring(0, 8)}... | ` +
        `${msgTokens.toLocaleString()} tokens (in:${message.usage.input_tokens}, out:${message.usage.output_tokens}) | ` +
        `$${msgCost.toFixed(4)} | Model: ${modelTier} | Project: ${message.projectName || 'unknown'}`
      );
    }
  }

  // Calculate burn rates
  const tokenBurnRate = calculateBurnRate(
    sessionMessages,
    now,
    (msg) => (msg.usage ? calculateLimitTokens(msg.usage) : 0)
  );

  const costBurnRate = calculateBurnRate(
    sessionMessages,
    now,
    (msg) => (msg.usage ? calculateMessageCost(msg.usage, msg.model) : 0)
  );

  const messageBurnRate = calculateBurnRate(
    sessionMessages,
    now,
    (msg) => (msg.usage ? 1 : 0)
  );

  outputChannel?.appendLine('');
  outputChannel?.appendLine('TOKEN BREAKDOWN FOR ACTIVE SESSION:');
  outputChannel?.appendLine(`  Session: ${startTime.toLocaleTimeString()} - ${sessionEndTime.toLocaleTimeString()}`);
  outputChannel?.appendLine(`  Messages in session: ${sessionMessages.length}`);
  outputChannel?.appendLine(`  Messages counted: ${messageCount}`);
  outputChannel?.appendLine(`  Input tokens: ${inputTokens.toLocaleString()}`);
  outputChannel?.appendLine(`  Output tokens: ${outputTokens.toLocaleString()}`);
  outputChannel?.appendLine(`  Cache creation: ${cacheCreationTokens.toLocaleString()} (NOT counted toward limit)`);
  outputChannel?.appendLine(`  Cache read: ${cacheReadTokens.toLocaleString()} (NOT counted toward limit)`);
  outputChannel?.appendLine(`  TOTAL (toward limit): ${totalTokens.toLocaleString()} = ${inputTokens.toLocaleString()} + ${outputTokens.toLocaleString()}`);
  outputChannel?.appendLine(`  Cost: $${totalCost.toFixed(2)}`);
  outputChannel?.appendLine(`  Time remaining: ${Math.floor(timeRemaining / 60000)} minutes`);
  outputChannel?.appendLine('');
  outputChannel?.appendLine('MODEL BREAKDOWN:');
  outputChannel?.appendLine(`  Opus: ${modelBreakdown.opus.toLocaleString()} tokens (${((modelBreakdown.opus / totalTokens) * 100).toFixed(1)}%)`);
  outputChannel?.appendLine(`  Sonnet: ${modelBreakdown.sonnet.toLocaleString()} tokens (${((modelBreakdown.sonnet / totalTokens) * 100).toFixed(1)}%)`);
  outputChannel?.appendLine(`  Haiku: ${modelBreakdown.haiku.toLocaleString()} tokens (${((modelBreakdown.haiku / totalTokens) * 100).toFixed(1)}%)`);
  outputChannel?.appendLine('');
  outputChannel?.appendLine('PROJECT BREAKDOWN:');
  Object.entries(projectBreakdown)
    .sort((a, b) => b[1] - a[1])
    .forEach(([project, tokens]) => {
      outputChannel?.appendLine(`  ${project}: ${tokens.toLocaleString()} tokens (${((tokens / totalTokens) * 100).toFixed(1)}%)`);
    });

  return {
    totalTokens,
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    totalCost,
    costLimit: planConfig.costLimit,
    messageCount,
    messageLimit: planConfig.messageLimit,
    sessionId,
    startTime,
    lastMessageTime,
    sessionEndTime,
    timeRemaining,
    isActive,
    tokenBurnRate,
    costBurnRate,
    messageBurnRate,
    modelBreakdown,
    projectBreakdown,
  };
}


/**
 * Calculate burn rate (units per minute) over the last 10 minutes
 */
function calculateBurnRate(
  messages: ClaudeMessage[],
  now: Date,
  valueExtractor: (msg: ClaudeMessage) => number
): number {
  const windowStart = now.getTime() - BURN_RATE_WINDOW_MS;

  const recentMessages = messages.filter(
    (msg) => new Date(msg.timestamp).getTime() >= windowStart
  );

  if (recentMessages.length === 0) {
    return 0;
  }

  let totalValue = 0;
  for (const message of recentMessages) {
    totalValue += valueExtractor(message);
  }

  const earliestTime = new Date(recentMessages[0].timestamp).getTime();
  const elapsedMinutes = (now.getTime() - earliestTime) / (60 * 1000);

  return elapsedMinutes > 0 ? totalValue / elapsedMinutes : 0;
}

/**
 * Format milliseconds to HH:MM:SS
 */
export function formatTimeRemaining(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Get status color based on usage percentage
 */
export function getStatusColor(usagePercent: number): string {
  if (usagePercent >= 80) {
    return '#ff6b6b'; // Red
  } else if (usagePercent >= 60) {
    return '#ffd93d'; // Yellow
  }
  return '#51cf66'; // Green
}
