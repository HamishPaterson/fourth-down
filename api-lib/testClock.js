import { beforeEach } from "node:test";

export const FIXED_TEST_TIME = "2026-10-15T03:16:31Z";
export const fixedTestNow = () => new Date(FIXED_TEST_TIME);

export function mockTestClock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(FIXED_TEST_TIME) });
}

// Use in sequential fixture tests. TestContext restores Date after every test;
// Node's default file isolation keeps other test files on their own clock.
export function useFixedTestClock() {
  beforeEach(mockTestClock);
}
