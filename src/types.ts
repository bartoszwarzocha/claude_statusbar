/**
 * Core types for Claude Status Bar Monitor
 */

/**
 * Token usage data from a single message
 */
export interface MessageUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

/**
 * A single message from Claude JSONL session file
 */
export interface ClaudeMessage {
  id: string;
  requestId: string; // Request ID for deduplication (combined with id)
  timestamp: string; // ISO 8601 format
  role: 'user' | 'assistant';
  model?: string; // Model identifier (e.g., "claude-sonnet-4-20250514")
  usage?: MessageUsage;
}

/**
 * Session metrics and timing information
 */
export interface SessionMetrics {
  // Token counts
  totalTokens: number; // input + output only (for limit calculation)
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;

  // Cost metrics
  totalCost: number; // Includes ALL tokens (input, output, cache creation, cache read)
  costLimit: number;

  // Message counts
  messageCount: number;
  messageLimit: number;

  // Session metadata
  sessionId: string;
  startTime: Date;
  lastMessageTime: Date;

  // Timing
  sessionEndTime: Date; // Predicted end (start + 5 hours)
  timeRemaining: number; // Milliseconds until session ends
  isActive: boolean; // Still within 5-hour window

  // Performance metrics
  tokenBurnRate: number; // Tokens per minute
  costBurnRate: number; // Cost per minute
  messageBurnRate: number; // Messages per minute
  estimatedTimeToLimit?: number; // Milliseconds until limit hit (if applicable)
}

/**
 * Configuration for plan limits
 */
export interface PlanConfig {
  plan: 'pro' | 'max5' | 'max20' | 'custom';
  tokenLimit: number;
  costLimit: number;
  messageLimit: number;
}

/**
 * Pricing rates for a specific model tier
 */
export interface ModelPricing {
  input: number; // Per million tokens
  output: number; // Per million tokens
  cacheCreation: number; // Per million tokens
  cacheRead: number; // Per million tokens
}

/**
 * Model tier classification
 */
export type ModelTier = 'opus' | 'sonnet' | 'haiku';
