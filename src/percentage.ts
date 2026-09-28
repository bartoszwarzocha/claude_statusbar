import * as vscode from 'vscode';

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Convert a consumed percentage to the configured display percentage.
 * The circle passes false explicitly because it always represents consumed context.
 */
export function displayPercent(usedPercent: number, showRemaining = getShowRemainingPercentage()): number {
  const used = clampPercent(usedPercent);
  return showRemaining ? 100 - used : used;
}

export function getShowRemainingPercentage(): boolean {
  return vscode.workspace
    .getConfiguration('claudeStatusBar')
    .get<boolean>('showRemainingPercentage', false);
}
