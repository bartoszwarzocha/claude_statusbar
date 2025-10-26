import { ModelPricing, ModelTier, MessageUsage } from './types';

/**
 * Pricing rates per million tokens for each model tier
 * Based on Claude API pricing as of January 2025
 */
export const MODEL_PRICING: Record<ModelTier, ModelPricing> = {
  opus: {
    input: 15.0,
    output: 75.0,
    cacheCreation: 18.75,
    cacheRead: 1.5,
  },
  sonnet: {
    input: 3.0,
    output: 15.0,
    cacheCreation: 3.75,
    cacheRead: 0.3,
  },
  haiku: {
    input: 0.25,
    output: 1.25,
    cacheCreation: 0.3,
    cacheRead: 0.03,
  },
};

/**
 * Model name to tier mapping
 */
const MODEL_TIER_MAP: Record<string, ModelTier> = {
  // Opus models
  'claude-3-opus': 'opus',
  'claude-opus-4-20250514': 'opus',

  // Sonnet models
  'claude-3-sonnet': 'sonnet',
  'claude-3-5-sonnet': 'sonnet',
  'claude-sonnet-4-20250514': 'sonnet',
  'claude-sonnet-4-5-20250929': 'sonnet',

  // Haiku models
  'claude-3-haiku': 'sonnet',
  'claude-3-5-haiku': 'haiku',
};

/**
 * Determine model tier from model name
 */
export function getModelTier(modelName: string | undefined): ModelTier {
  if (!modelName) {
    return 'sonnet'; // Default to Sonnet pricing
  }

  const tier = MODEL_TIER_MAP[modelName];
  return tier || 'sonnet'; // Default to Sonnet if unknown
}

/**
 * Calculate cost for a single message based on token usage
 * Formula: (tokens / 1,000,000) × rate
 *
 * IMPORTANT: Unlike token limits (which exclude cache tokens),
 * cost calculation INCLUDES all token types:
 * - input_tokens
 * - output_tokens
 * - cache_creation_input_tokens
 * - cache_read_input_tokens
 */
export function calculateMessageCost(
  usage: MessageUsage,
  modelName?: string
): number {
  const tier = getModelTier(modelName);
  const pricing = MODEL_PRICING[tier];

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  const cacheCreationCost =
    ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cacheCreation;
  const cacheReadCost =
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cacheRead;

  const totalCost = inputCost + outputCost + cacheCreationCost + cacheReadCost;

  // Round to 6 decimal places to avoid floating point errors
  return Math.round(totalCost * 1_000_000) / 1_000_000;
}

/**
 * Format cost as currency string
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
