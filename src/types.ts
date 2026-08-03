/**
 * Core types for Claude Status Bar Monitor
 */

/**
 * Split of cache-creation tokens by cache TTL.
 * Claude Code writes 1-hour cache entries, which cost 2x base input
 * (vs 1.25x for the 5-minute cache) - this split is required for correct cost.
 */
export interface CacheCreationBreakdown {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

/**
 * Server-side tool usage counters (billed separately from tokens)
 */
export interface ServerToolUse {
  web_search_requests?: number;
  web_fetch_requests?: number;
  code_execution_requests?: number;
}

/**
 * Token usage data from a single message
 */
export interface MessageUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;

  /** Per-TTL split of cache_creation_input_tokens (Claude Code uses 1h) */
  cache_creation?: CacheCreationBreakdown;

  /** "fast" doubles Opus 5 / Opus 4.8 pricing to $10/$50 per MTok */
  speed?: string;

  /** "us" applies a 1.1x multiplier to every token category */
  inference_geo?: string;

  /** "standard" | "priority" | "batch" */
  service_tier?: string;

  /** Server tool calls (e.g. web search at $10 / 1000 requests) */
  server_tool_use?: ServerToolUse;
}

/**
 * A single message from Claude JSONL session file
 */
export interface ClaudeMessage {
  id: string;
  requestId: string; // Request ID for deduplication (combined with id)
  timestamp: string; // ISO 8601 format
  role: 'user' | 'assistant';
  model?: string; // Model identifier (e.g., "claude-opus-5")
  projectName?: string; // Project name from directory structure
  usage?: MessageUsage;
}

/**
 * Model family used for aggregation / display grouping
 */
export type ModelTier = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'unknown';

/**
 * One rate limit window as reported by Claude Code itself
 */
export interface RateLimitWindow {
  usedPercent: number; // 0-100, authoritative (comes from the API)
  resetsAt: Date;
}

/**
 * Authoritative rate limit data bridged from Claude Code's status line.
 * Only available for Claude.ai (Pro/Max) subscribers.
 */
export interface RateLimitSnapshot {
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
  /** When Claude Code last wrote this snapshot */
  updatedAt: Date;
  /** Claude Code's own client-side session cost estimate, if present */
  sessionCostUsd?: number;
  /** Context window usage percentage of the live session */
  contextUsedPercent?: number;
  model?: string;
  effortLevel?: string;
  fastMode?: boolean;
}

/**
 * Session metrics and timing information
 */
export interface SessionMetrics {
  // Token counts
  totalTokens: number; // input + output only (for limit calculation)
  inputTokens: number;
  cacheCreationTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;

  // Cost metrics
  totalCost: number; // Includes ALL tokens + server tool calls
  costLimit?: number; // Optional user-defined budget
  webSearchRequests: number;

  // Message counts
  messageCount: number;
  messageLimit?: number; // Optional user-defined budget

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

  // Token breakdown by model family
  modelBreakdown: Record<ModelTier, number>;

  /** Cost breakdown by concrete model id */
  costByModel: Record<string, number>;

  // Token breakdown by project
  projectBreakdown: Record<string, number>; // projectName -> token count

  /** Message counts per project, for the Message Count composition bar */
  messagesByProject: Record<string, number>;

  /** Real 5-hour / 7-day usage, when the status line bridge is active */
  rateLimits?: RateLimitSnapshot;

  /**
   * Context usage per Claude Code session. The context window belongs to one
   * conversation, so with several sessions open there is no single value -
   * they are listed instead. Newest first.
   */
  sessionContexts: SessionContextInfo[];

  /**
   * Why the limits are or are not available:
   *  - 'off'     the bridge is not installed
   *  - 'waiting' the bridge runs but Claude Code reports no limits, which means
   *              either an API key / Bedrock / Vertex login (no such windows
   *              exist) or no model response yet in this session
   *  - 'live'    real percentages are being read
   */
  rateLimitsStatus: 'off' | 'waiting' | 'live';

  /** Rolling 7-day totals, used when no bridge data is available */
  weekTokens: number;
  weekCost: number;
}

/** One Claude Code session's context usage, as reported by the bridge */
export interface SessionContextInfo {
  sessionId: string;
  label: string;
  contextPercent?: number;
  contextWindowSize?: number;
  model?: string;
  /** Conversation title, shown on hover */
  title?: string;
  updatedAt: Date;
}

/**
 * Optional user-defined budgets for the 5-hour window.
 *
 * IMPORTANT: Anthropic does not publish token/message quotas, and the real limits
 * are weighted by model and effort level. Everything here is a pacing target
 * chosen by the user - authoritative usage comes from SessionMetrics.rateLimits.
 * An undefined budget means "no target": the metric is shown as a measured value.
 */
export interface PlanConfig {
  /** Token budget for the 5-hour window (undefined = no budget, show raw count) */
  tokenLimit?: number;
  /** Cost budget in USD */
  costLimit?: number;
  /** Message budget */
  messageLimit?: number;
}

/**
 * Pricing rates for one model, in USD per million tokens
 */
export interface ModelPricing {
  input: number;
  output: number;
  /** 5-minute cache write (1.25x input) */
  cacheWrite5m: number;
  /** 1-hour cache write (2x input) - what Claude Code actually uses */
  cacheWrite1h: number;
  /** Cache read / hit (0.1x input) */
  cacheRead: number;
}
