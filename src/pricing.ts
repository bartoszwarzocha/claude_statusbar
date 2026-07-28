import { ModelPricing, ModelTier, MessageUsage } from './types';

/**
 * Model pricing, USD per million tokens.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Verified: 2026-07-26
 *
 * Cache multipliers are fixed relative to base input price:
 *   5-minute cache write = 1.25x, 1-hour cache write = 2x, cache read = 0.1x
 *
 * Keys are matched as PREFIXES of the model id (longest match wins), so dated
 * snapshots like "claude-opus-4-5-20251101" and suffixed variants like
 * "claude-sonnet-4-5-20250929[1m]" resolve to the right entry.
 */

/** Build an entry from base input/output, deriving cache rates from the multipliers */
function rates(input: number, output: number): ModelPricing {
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
  };
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // --- Fable / Mythos tier: $10 / $50 ---
  'claude-fable-5': rates(10, 50),
  'claude-mythos-5': rates(10, 50),
  'claude-mythos-preview': rates(10, 50),

  // --- Opus 4.5 and later: $5 / $25 ---
  'claude-opus-5': rates(5, 25),
  'claude-opus-4-8': rates(5, 25),
  'claude-opus-4-7': rates(5, 25),
  'claude-opus-4-6': rates(5, 25),
  'claude-opus-4-5': rates(5, 25),

  // --- Legacy Opus: $15 / $75 ---
  'claude-opus-4-1': rates(15, 75),
  'claude-opus-4': rates(15, 75),
  'claude-3-opus': rates(15, 75),

  // --- Sonnet 5: introductory $2 / $10 through 2026-08-31, then $3 / $15 ---
  // Handled dynamically in getModelPricing(); this entry is the standard rate.
  'claude-sonnet-5': rates(3, 15),

  // --- Sonnet: $3 / $15 ---
  'claude-sonnet-4-6': rates(3, 15),
  'claude-sonnet-4-5': rates(3, 15),
  'claude-sonnet-4': rates(3, 15),
  'claude-3-7-sonnet': rates(3, 15),
  'claude-3-5-sonnet': rates(3, 15),
  'claude-3-sonnet': rates(3, 15),

  // --- Haiku ---
  'claude-haiku-4-5': rates(1, 5),
  'claude-3-5-haiku': rates(0.8, 4),
  'claude-3-haiku': rates(0.25, 1.25),
};

/** Sonnet 5 introductory pricing window (inclusive of the end date) */
const SONNET_5_INTRO_PRICING = rates(2, 10);
const SONNET_5_INTRO_ENDS = Date.parse('2026-09-01T00:00:00Z');

/**
 * Fast mode (research preview) reprices Opus 5 / Opus 4.8 at $10 / $50.
 * Detected via usage.speed === "fast".
 */
const FAST_MODE_PRICING = rates(10, 50);
const FAST_MODE_MODELS = ['claude-opus-5', 'claude-opus-4-8'];

/** US-only inference (inference_geo: "us") applies a 1.1x multiplier to all categories */
const US_GEO_MULTIPLIER = 1.1;

/** Web search is billed at $10 per 1,000 requests */
const WEB_SEARCH_COST_PER_REQUEST = 10 / 1000;

/** Fallback when the model id is unknown but a family can be guessed */
const TIER_FALLBACK_PRICING: Record<Exclude<ModelTier, 'unknown'>, ModelPricing> = {
  fable: rates(10, 50),
  opus: rates(5, 25),
  sonnet: rates(3, 15),
  haiku: rates(1, 5),
};

/** Prefix keys sorted longest-first so "claude-opus-4-5" beats "claude-opus-4" */
const PRICING_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

const warnedModels = new Set<string>();

/**
 * Normalize a model id: lowercase and strip cloud-provider prefixes.
 * "us.anthropic.claude-opus-5-v1:0" -> "claude-opus-5-v1:0"
 */
export function normalizeModelId(modelName: string): string {
  let id = modelName.trim().toLowerCase();
  id = id.replace(/^(us|eu|apac|global)\./, '');
  id = id.replace(/^anthropic\./, '');
  id = id.replace(/^(bedrock|vertex|vertex_ai|foundry)\//, '');
  return id;
}

/**
 * Determine the model family. Used for display grouping and as a pricing
 * fallback for model ids released after this table was written.
 */
export function getModelTier(modelName: string | undefined): ModelTier {
  if (!modelName) {
    return 'unknown';
  }

  const id = normalizeModelId(modelName);

  // Claude Code emits "<synthetic>" for locally generated messages - not billable
  if (id.startsWith('<')) {
    return 'unknown';
  }

  if (id.includes('fable') || id.includes('mythos')) {
    return 'fable';
  }
  if (id.includes('opus')) {
    return 'opus';
  }
  if (id.includes('haiku')) {
    return 'haiku';
  }
  if (id.includes('sonnet')) {
    return 'sonnet';
  }

  return 'unknown';
}

/**
 * Resolve pricing for a concrete model id, honouring time-limited introductory
 * pricing and fast mode.
 *
 * @param at reference date for time-dependent pricing (defaults to now)
 */
export function getModelPricing(
  modelName: string | undefined,
  usage?: MessageUsage,
  at: Date = new Date()
): ModelPricing | null {
  if (!modelName) {
    // No model recorded: assume the current default tier rather than dropping cost
    return TIER_FALLBACK_PRICING.sonnet;
  }

  const id = normalizeModelId(modelName);

  // Synthetic / local messages carry no billable usage
  if (id.startsWith('<')) {
    return null;
  }

  const key = PRICING_KEYS.find((k) => id.startsWith(k));

  // Fast mode overrides the base rate on supported models
  if (usage?.speed === 'fast' && key && FAST_MODE_MODELS.includes(key)) {
    return FAST_MODE_PRICING;
  }

  let pricing: ModelPricing | undefined;

  if (key === 'claude-sonnet-5' && at.getTime() < SONNET_5_INTRO_ENDS) {
    pricing = SONNET_5_INTRO_PRICING;
  } else if (key) {
    pricing = MODEL_PRICING[key];
  }

  if (!pricing) {
    const tier = getModelTier(modelName);
    if (tier === 'unknown') {
      if (!warnedModels.has(id)) {
        warnedModels.add(id);
        console.warn(
          `[Claude Status Bar] Unknown model "${modelName}" - cost cannot be estimated`
        );
      }
      return null;
    }
    if (!warnedModels.has(id)) {
      warnedModels.add(id);
      console.warn(
        `[Claude Status Bar] Model "${modelName}" not in pricing table - using ${tier} tier rates`
      );
    }
    pricing = TIER_FALLBACK_PRICING[tier];
  }

  return pricing;
}

/**
 * Split cache-creation tokens into 5-minute and 1-hour buckets.
 *
 * Claude Code writes 1-hour cache entries almost exclusively, and those cost
 * 2x base input instead of 1.25x. When the per-TTL breakdown is missing (older
 * transcripts), fall back to treating everything as a 5-minute write.
 */
export function splitCacheCreation(usage: MessageUsage): {
  write5m: number;
  write1h: number;
} {
  const total = usage.cache_creation_input_tokens || 0;
  const breakdown = usage.cache_creation;

  if (!breakdown) {
    return { write5m: total, write1h: 0 };
  }

  const write5m = breakdown.ephemeral_5m_input_tokens || 0;
  const write1h = breakdown.ephemeral_1h_input_tokens || 0;

  // If the breakdown is present but empty while a total exists, trust the total
  if (write5m === 0 && write1h === 0 && total > 0) {
    return { write5m: total, write1h: 0 };
  }

  return { write5m, write1h };
}

/**
 * Calculate cost for a single message.
 *
 * Includes ALL token categories (unlike limit accounting, which counts only
 * input + output), plus server tool charges. Applies the 1.1x data-residency
 * multiplier when inference ran US-only.
 */
export function calculateMessageCost(
  usage: MessageUsage,
  modelName?: string,
  at?: Date
): number {
  const pricing = getModelPricing(modelName, usage, at);

  // Server tool charges apply regardless of whether we can price the tokens
  const webSearchCost =
    (usage.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_COST_PER_REQUEST;

  if (!pricing) {
    return round6(webSearchCost);
  }

  const { write5m, write1h } = splitCacheCreation(usage);

  const tokenCost =
    ((usage.input_tokens || 0) / 1_000_000) * pricing.input +
    ((usage.output_tokens || 0) / 1_000_000) * pricing.output +
    (write5m / 1_000_000) * pricing.cacheWrite5m +
    (write1h / 1_000_000) * pricing.cacheWrite1h +
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cacheRead;

  const geoMultiplier = usage.inference_geo === 'us' ? US_GEO_MULTIPLIER : 1;

  return round6(tokenCost * geoMultiplier + webSearchCost);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Format cost as currency string
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
