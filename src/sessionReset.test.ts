/**
 * Test suite for session reset notification logic
 * Tests the 30-second timeout behavior for detecting new sessions
 */

import * as assert from 'assert';

// Mock types
interface SessionMetrics {
  isActive: boolean;
  totalTokens: number;
  startTime: Date;
  sessionEndTime: Date;
  timeRemaining: number;
}

// Simulate the state variables from extension.ts
class SessionResetTester {
  private currentSession: SessionMetrics | null = null;
  private isRefreshing = false;
  private sessionJustEnded = false;
  private refreshingStartTime: number | null = null;
  private notifications: string[] = [];

  // Simulate updateMetrics() logic
  updateMetrics(hasNewSession: boolean, currentTime: number) {
    if (hasNewSession) {
      // New session found
      const metrics: SessionMetrics = {
        isActive: true,
        totalTokens: 1000,
        startTime: new Date(currentTime),
        sessionEndTime: new Date(currentTime + 5 * 60 * 60 * 1000),
        timeRemaining: 5 * 60 * 60 * 1000,
      };

      this.currentSession = metrics;
      this.isRefreshing = false;
      this.sessionJustEnded = false;
      this.refreshingStartTime = null;

      console.log(`[${new Date(currentTime).toISOString()}] New session detected - showing stats`);
    } else {
      // No session found
      if (this.sessionJustEnded && this.refreshingStartTime) {
        const elapsedTime = currentTime - this.refreshingStartTime;

        if (elapsedTime >= 30000) {
          // 30 seconds passed - show notification
          this.notifications.push('NO_SESSION_WARNING');
          console.log(`[${new Date(currentTime).toISOString()}] 30s elapsed - showing NO SESSION notification`);
          this.sessionJustEnded = false;
          this.refreshingStartTime = null;
        } else {
          console.log(`[${new Date(currentTime).toISOString()}] Waiting... ${elapsedTime}ms / 30000ms`);
        }
      }

      this.currentSession = null;
      this.isRefreshing = false;
    }
  }

  // Simulate timer reaching 0
  triggerSessionReset(currentTime: number) {
    this.isRefreshing = true;
    this.sessionJustEnded = true;
    this.refreshingStartTime = currentTime;
    this.notifications.push('SESSION_ENDED');

    console.log(`[${new Date(currentTime).toISOString()}] Timer = 0 - SESSION ENDED notification`);
  }

  // Getters for assertions
  getNotifications(): string[] {
    return this.notifications;
  }

  getCurrentSession(): SessionMetrics | null {
    return this.currentSession;
  }

  isWaitingForSession(): boolean {
    return this.sessionJustEnded && this.refreshingStartTime !== null;
  }

  getElapsedWaitTime(currentTime: number): number {
    if (!this.refreshingStartTime) return 0;
    return currentTime - this.refreshingStartTime;
  }

  reset() {
    this.currentSession = null;
    this.isRefreshing = false;
    this.sessionJustEnded = false;
    this.refreshingStartTime = null;
    this.notifications = [];
  }
}

// Test Suite
console.log('='.repeat(80));
console.log('SESSION RESET NOTIFICATION TESTS');
console.log('='.repeat(80));
console.log('');

// Test 1: Timer = 0, NO activity for 30 seconds
console.log('TEST 1: Timer = 0, no activity for 30 seconds');
console.log('-'.repeat(80));
{
  const tester = new SessionResetTester();
  const startTime = Date.now();

  // T=0s: Timer reaches 0
  tester.triggerSessionReset(startTime);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should have 1 notification');
  assert.strictEqual(tester.getNotifications()[0], 'SESSION_ENDED', 'First notification should be SESSION_ENDED');

  // T=5s: First updateMetrics check - no session
  tester.updateMetrics(false, startTime + 5000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification (< 30s)');
  assert.strictEqual(tester.isWaitingForSession(), true, 'Should be waiting for session');

  // T=10s: Second check - no session
  tester.updateMetrics(false, startTime + 10000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification (< 30s)');

  // T=15s: Third check - no session
  tester.updateMetrics(false, startTime + 15000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification (< 30s)');

  // T=20s: Fourth check - no session
  tester.updateMetrics(false, startTime + 20000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification (< 30s)');

  // T=25s: Fifth check - no session
  tester.updateMetrics(false, startTime + 25000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification (< 30s)');

  // T=30s: Sixth check - no session (30s reached!)
  tester.updateMetrics(false, startTime + 30000);
  assert.strictEqual(tester.getNotifications().length, 2, 'Should have 2 notifications now');
  assert.strictEqual(tester.getNotifications()[1], 'NO_SESSION_WARNING', 'Second notification should be NO_SESSION_WARNING');
  assert.strictEqual(tester.isWaitingForSession(), false, 'Should no longer be waiting');

  // T=35s: Seventh check - should not trigger again
  tester.updateMetrics(false, startTime + 35000);
  assert.strictEqual(tester.getNotifications().length, 2, 'Should still have only 2 notifications (no duplicates)');

  console.log('✅ TEST 1 PASSED: Notification #2 appears after exactly 30 seconds');
}
console.log('');

// Test 2: Timer = 0, activity detected at T=10s
console.log('TEST 2: Timer = 0, activity detected at T=10s');
console.log('-'.repeat(80));
{
  const tester = new SessionResetTester();
  const startTime = Date.now();

  // T=0s: Timer reaches 0
  tester.triggerSessionReset(startTime);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should have 1 notification');

  // T=5s: First check - no session
  tester.updateMetrics(false, startTime + 5000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification');

  // T=10s: Second check - NEW SESSION FOUND!
  tester.updateMetrics(true, startTime + 10000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification (no warning)');
  assert.strictEqual(tester.getCurrentSession()?.isActive, true, 'Should have active session');
  assert.strictEqual(tester.isWaitingForSession(), false, 'Should no longer be waiting');

  // T=15s: Third check - session still active
  tester.updateMetrics(true, startTime + 15000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification');

  // T=30s: Even at 30s, no warning because session was found
  tester.updateMetrics(true, startTime + 30000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification (no warning)');

  console.log('✅ TEST 2 PASSED: Activity detected early, no warning notification');
}
console.log('');

// Test 3: Timer = 0, activity detected at T=29s (just before timeout)
console.log('TEST 3: Timer = 0, activity detected at T=29s (edge case)');
console.log('-'.repeat(80));
{
  const tester = new SessionResetTester();
  const startTime = Date.now();

  // T=0s: Timer reaches 0
  tester.triggerSessionReset(startTime);

  // T=5s, 10s, 15s, 20s, 25s: No activity
  tester.updateMetrics(false, startTime + 5000);
  tester.updateMetrics(false, startTime + 10000);
  tester.updateMetrics(false, startTime + 15000);
  tester.updateMetrics(false, startTime + 20000);
  tester.updateMetrics(false, startTime + 25000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should still have only 1 notification');

  // T=29s: Activity detected JUST before 30s timeout!
  tester.updateMetrics(true, startTime + 29000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should have only 1 notification (no warning)');
  assert.strictEqual(tester.getCurrentSession()?.isActive, true, 'Should have active session');

  console.log('✅ TEST 3 PASSED: Activity detected at 29s prevents warning');
}
console.log('');

// Test 4: Timer = 0, activity detected at T=2s (immediate)
console.log('TEST 4: Timer = 0, immediate activity at T=2s');
console.log('-'.repeat(80));
{
  const tester = new SessionResetTester();
  const startTime = Date.now();

  // T=0s: Timer reaches 0
  tester.triggerSessionReset(startTime);

  // T=2s: Immediate activity detected!
  tester.updateMetrics(true, startTime + 2000);
  assert.strictEqual(tester.getNotifications().length, 1, 'Should have only 1 notification');
  assert.strictEqual(tester.getCurrentSession()?.isActive, true, 'Should have active session immediately');
  assert.strictEqual(tester.isWaitingForSession(), false, 'Should no longer be waiting');

  console.log('✅ TEST 4 PASSED: Immediate activity detection works');
}
console.log('');

// Test 5: Timer = 0, activity at T=31s (after timeout already triggered)
console.log('TEST 5: Timer = 0, activity appears AFTER 30s timeout');
console.log('-'.repeat(80));
{
  const tester = new SessionResetTester();
  const startTime = Date.now();

  // T=0s: Timer reaches 0
  tester.triggerSessionReset(startTime);

  // T=5s through T=30s: No activity
  for (let t = 5; t <= 30; t += 5) {
    tester.updateMetrics(false, startTime + t * 1000);
  }
  assert.strictEqual(tester.getNotifications().length, 2, 'Should have 2 notifications after 30s');

  // T=31s: Activity appears AFTER warning was shown
  tester.updateMetrics(true, startTime + 31000);
  assert.strictEqual(tester.getNotifications().length, 2, 'Should still have 2 notifications');
  assert.strictEqual(tester.getCurrentSession()?.isActive, true, 'Should have active session now');

  console.log('✅ TEST 5 PASSED: Late activity (after warning) handled correctly');
}
console.log('');

// Test 6: Multiple session resets in sequence
console.log('TEST 6: Multiple session resets in sequence');
console.log('-'.repeat(80));
{
  const tester = new SessionResetTester();
  let startTime = Date.now();

  // First reset
  tester.triggerSessionReset(startTime);
  tester.updateMetrics(true, startTime + 5000); // Activity found
  assert.strictEqual(tester.getNotifications().length, 1, 'First reset: 1 notification');

  tester.reset();
  startTime = Date.now();

  // Second reset - no activity
  tester.triggerSessionReset(startTime);
  for (let t = 5; t <= 30; t += 5) {
    tester.updateMetrics(false, startTime + t * 1000);
  }
  assert.strictEqual(tester.getNotifications().length, 2, 'Second reset: 2 notifications after 30s');

  console.log('✅ TEST 6 PASSED: Multiple resets handled correctly');
}
console.log('');

// Test 7: Elapsed time calculation accuracy
console.log('TEST 7: Elapsed time calculation accuracy');
console.log('-'.repeat(80));
{
  const tester = new SessionResetTester();
  const startTime = Date.now();

  tester.triggerSessionReset(startTime);

  // Check elapsed time at various points
  tester.updateMetrics(false, startTime + 5000);
  assert.strictEqual(tester.getElapsedWaitTime(startTime + 5000), 5000, 'Elapsed time at T=5s should be 5000ms');

  tester.updateMetrics(false, startTime + 15000);
  assert.strictEqual(tester.getElapsedWaitTime(startTime + 15000), 15000, 'Elapsed time at T=15s should be 15000ms');

  tester.updateMetrics(false, startTime + 29999);
  assert.strictEqual(tester.getElapsedWaitTime(startTime + 29999), 29999, 'Elapsed time at T=29999ms should be 29999ms');
  assert.strictEqual(tester.getNotifications().length, 1, 'Should not trigger at 29999ms');

  tester.updateMetrics(false, startTime + 30000);
  assert.strictEqual(tester.getNotifications().length, 2, 'Should trigger at exactly 30000ms');
  // After notification, refreshingStartTime is reset to null, so elapsed time is 0
  assert.strictEqual(tester.getElapsedWaitTime(startTime + 30000), 0, 'After notification, elapsed time resets to 0');

  console.log('✅ TEST 7 PASSED: Elapsed time calculation is accurate');
}
console.log('');

// Summary
console.log('='.repeat(80));
console.log('ALL TESTS PASSED! ✅');
console.log('='.repeat(80));
console.log('');
console.log('Summary:');
console.log('- Test 1: 30-second timeout triggers notification correctly');
console.log('- Test 2: Early activity (10s) prevents notification');
console.log('- Test 3: Activity at 29s (edge case) prevents notification');
console.log('- Test 4: Immediate activity (2s) works correctly');
console.log('- Test 5: Late activity (after timeout) handled properly');
console.log('- Test 6: Multiple resets work correctly');
console.log('- Test 7: Time calculations are accurate');
console.log('');
console.log('Logic verification:');
console.log('✅ Notification #1 always appears at T=0');
console.log('✅ Notification #2 appears ONLY after 30s of no activity');
console.log('✅ Activity detected < 30s immediately shows stats (no notification #2)');
console.log('✅ No duplicate notifications');
console.log('✅ State properly reset after session found');
