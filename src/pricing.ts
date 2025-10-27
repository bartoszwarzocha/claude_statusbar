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
 * Determine model tier from model name using pattern matching
 * This dynamically recognizes opus/sonnet/haiku regardless of version number
 *
 * Examples:
 * - "claude-3-opus" → opus
 * - "claude-opus-4-20250514" → opus
 * - "claude-opus-4-1-20250805" → opus
 * - "claude-3-5-sonnet" → sonnet
 * - "claude-sonnet-4-5-20250929" → sonnet
 * - "claude-3-haiku" → haiku
 */
export function getModelTier(modelName: string | undefined): ModelTier {
  if (!modelName) {
    return 'sonnet'; // Default to Sonnet pricing
  }

  // Convert to lowercase for case-insensitive matching
  const nameLower = modelName.toLowerCase();

  // Check for tier keywords in the model name
  if (nameLower.includes('opus')) {
    return 'opus';
  }

  if (nameLower.includes('haiku')) {
    return 'haiku';
  }

  if (nameLower.includes('sonnet')) {
    return 'sonnet';
  }

  // Log unknown models for debugging
  console.warn(`[Claude Status Bar] Unknown model tier for: "${modelName}" - defaulting to sonnet`);

  return 'sonnet'; // Default to Sonnet if pattern not recognized
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
