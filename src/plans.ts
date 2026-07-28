import { PlanConfig } from './types';

/**
 * User-defined budgets for the 5-hour window.
 *
 * These are NOT quotas. Anthropic does not publish token or message limits, and
 * real consumption is weighted by model and effort level over a 5-hour window
 * plus weekly windows. Authoritative usage comes from Claude Code itself - see
 * rateLimits.ts. Everything here is a pacing target the user chooses, and every
 * one of them is optional: an unset budget means the metric is reported as a
 * plain measured value.
 *
 * Suggested starting points, for anyone who wants a target but has no feel for
 * the numbers yet. Deliberately not applied by default.
 */
export const SUGGESTED_BUDGETS: Required<PlanConfig> = {
  tokenLimit: 200_000,
  costLimit: 50,
  messageLimit: 500,
};

export interface Budgets {
  tokenLimit?: number;
  costLimit?: number;
  messageLimit?: number;
}

/**
 * Build the effective configuration from whatever the user set.
 * A value of 0 or less explicitly disables that budget.
 */
export function getPlanConfig(budgets: Budgets = {}): PlanConfig {
  const config: PlanConfig = {};

  const apply = (key: keyof Budgets) => {
    const value = budgets[key];
    if (value === undefined || value === null || Number.isNaN(value)) {
      return;
    }
    config[key] = value > 0 ? value : undefined;
  };

  apply('tokenLimit');
  apply('costLimit');
  apply('messageLimit');

  return config;
}

/**
 * Percentage of a budget consumed, or undefined when no budget is set.
 */
export function budgetPercent(value: number, budget?: number): number | undefined {
  if (!budget || budget <= 0) {
    return undefined;
  }
  return (value / budget) * 100;
}
