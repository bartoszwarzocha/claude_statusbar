import { PlanConfig } from './types';

/**
 * Plan limits based on Claude Code subscription tiers
 * Source: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
 */
export const PLAN_LIMITS: Record<'pro' | 'max5' | 'max20' | 'custom', PlanConfig> = {
  pro: {
    plan: 'pro',
    tokenLimit: 19_000,
    costLimit: 18.0,
    messageLimit: 250,
  },
  max5: {
    plan: 'max5',
    tokenLimit: 88_000,
    costLimit: 35.0,
    messageLimit: 1_000,
  },
  max20: {
    plan: 'max20',
    tokenLimit: 220_000,
    costLimit: 140.0,
    messageLimit: 2_000,
  },
  custom: {
    plan: 'custom',
    tokenLimit: 44_000, // Default, will be overridden by user config
    costLimit: 50.0,
    messageLimit: 250,
  },
};

/**
 * Get plan configuration
 */
export function getPlanConfig(
  plan: 'pro' | 'max5' | 'max20' | 'custom',
  customTokenLimit?: number
): PlanConfig {
  const config = { ...PLAN_LIMITS[plan] };

  // Override token limit for custom plan
  if (plan === 'custom' && customTokenLimit) {
    config.tokenLimit = customTokenLimit;
  }

  return config;
}

/**
 * Format token count for display (e.g., 19000 -> "19k", 88000 -> "88k")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  } else if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(0)}k`;
  }
  return tokens.toString();
}
