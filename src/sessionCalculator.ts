import { ClaudeMessage, SessionMetrics, PlanConfig } from './types';
import { calculateLimitTokens } from './sessionParser';
import { calculateMessageCost } from './pricing';

const SESSION_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds
const BURN_RATE_WINDOW_MS = 10 * 60 * 1000; // Last 10 minutes for burn rate

/**
 * Session set within a 5-hour window
 */
interface SessionSet {
  startTime: Date;
  endTime: Date;
  lastMessageTime: Date;
  messages: ClaudeMessage[];
}

/**
 * Calculate session metrics from ALL messages across all files
 */
export function calculateSessionMetrics(
  messages: ClaudeMessage[],
  sessionId: string,
  planConfig: PlanConfig
): SessionMetrics | null {
  if (messages.length === 0) {
    return null;
  }

  const now = new Date();

  // Step 1: Remove duplicate messages by ID (in case same message appears in multiple files)
  const uniqueMessages = Array.from(
    new Map(messages.map((m) => [m.id, m])).values()
  );

  console.log(
    `🔄 Total messages: ${messages.length}, Unique messages: ${uniqueMessages.length}`
  );

  // Step 2: Sort all messages by timestamp
  const sortedMessages = [...uniqueMessages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Step 3: Filter to only today's messages
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const todayMessages = sortedMessages.filter((msg) => {
    const msgTime = new Date(msg.timestamp);
    return msgTime >= startOfToday;
  });

  console.log(
    `📅 Sorted messages: ${sortedMessages.length}, Today's messages: ${todayMessages.length}`
  );

  if (todayMessages.length === 0) {
    return null; // No messages from today
  }

  // Step 4: Group into 5-hour sets starting from the very first message of today
  const sets = groupIntoFiveHourSets(todayMessages);

  console.log(`📦 Created ${sets.length} session sets`);

  if (sets.length === 0) {
    return null;
  }

  // Step 5: Find the last set that overlaps with current time
  const activeSets = sets.filter((set) => {
    return now >= set.startTime && now <= set.endTime;
  });

  console.log(`✅ Active sets found: ${activeSets.length}`);

  // Get the last (most recent) overlapping set
  const activeSet = activeSets.length > 0 ? activeSets[activeSets.length - 1] : null;

  if (!activeSet) {
    return null; // No active session - all sets have expired
  }

  console.log(
    `🎯 Active set: ${activeSet.startTime.toLocaleTimeString()} - ${activeSet.endTime.toLocaleTimeString()} with ${activeSet.messages.length} messages`
  );

  // Calculate metrics for the active set
  const startTime = activeSet.startTime;
  const lastMessageTime = activeSet.lastMessageTime;
  const sessionEndTime = activeSet.endTime;
  const timeRemaining = Math.max(0, sessionEndTime.getTime() - now.getTime());
  const isActive = timeRemaining > 0;

  // Calculate token totals and costs for messages in this set
  let totalTokens = 0;
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;
  let messageCount = 0;

  const seenIds = new Set<string>();

  for (const message of activeSet.messages) {
    if (message.usage) {
      // Skip duplicates
      if (seenIds.has(message.id)) {
        continue;
      }
      seenIds.add(message.id);

      messageCount++;
      const msgTokens = calculateLimitTokens(message.usage);
      totalTokens += msgTokens;
      inputTokens += message.usage.input_tokens;
      cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
      cacheReadTokens += message.usage.cache_read_input_tokens || 0;
      outputTokens += message.usage.output_tokens;

      // Calculate cost (includes ALL tokens)
      totalCost += calculateMessageCost(message.usage, message.model);
    }
  }

  // Calculate burn rates
  const tokenBurnRate = calculateBurnRate(
    activeSet.messages,
    now,
    (msg) => (msg.usage ? calculateLimitTokens(msg.usage) : 0)
  );

  const costBurnRate = calculateBurnRate(
    activeSet.messages,
    now,
    (msg) => (msg.usage ? calculateMessageCost(msg.usage, msg.model) : 0)
  );

  const messageBurnRate = calculateBurnRate(
    activeSet.messages,
    now,
    (msg) => (msg.usage ? 1 : 0)
  );

  console.log(`💰 Token breakdown:`);
  console.log(`   Input: ${inputTokens}`);
  console.log(`   Cache creation: ${cacheCreationTokens} (not counted toward limit)`);
  console.log(`   Cache read: ${cacheReadTokens} (not counted toward limit)`);
  console.log(`   Output: ${outputTokens}`);
  console.log(`   TOTAL (toward limit): ${totalTokens}`);
  console.log(`   Cost: $${totalCost.toFixed(2)}`);
  console.log(`   Messages: ${messageCount}`);

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
  };
}

/**
 * Group messages into 5-hour sets
 * Starting from the first message, create a 5-hour window.
 * Any messages outside that window start a new 5-hour set.
 */
function groupIntoFiveHourSets(messages: ClaudeMessage[]): SessionSet[] {
  if (messages.length === 0) {
    return [];
  }

  const sets: SessionSet[] = [];
  let currentSet: SessionSet | null = null;

  for (const message of messages) {
    const msgTime = new Date(message.timestamp);

    if (!currentSet) {
      // Start first set from the very first message
      currentSet = {
        startTime: msgTime,
        endTime: new Date(msgTime.getTime() + SESSION_DURATION_MS),
        lastMessageTime: msgTime,
        messages: [message],
      };
    } else if (msgTime <= currentSet.endTime) {
      // Message falls within current 5-hour set
      currentSet.messages.push(message);
      currentSet.lastMessageTime = msgTime;
    } else {
      // Message is outside current set - save current and start new set
      sets.push(currentSet);
      currentSet = {
        startTime: msgTime,
        endTime: new Date(msgTime.getTime() + SESSION_DURATION_MS),
        lastMessageTime: msgTime,
        messages: [message],
      };
    }
  }

  // Add the last set
  if (currentSet) {
    sets.push(currentSet);
  }

  return sets;
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
