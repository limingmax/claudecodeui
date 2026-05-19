import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDefaultLimits,
  mergeUserLimits,
  DEFAULT_PROBE_PROMPT,
  DEFAULT_REVIEW_PROMPT,
} from '../config.js';
import type { AutopilotLimits } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore a set of env vars around a test. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// getDefaultLimits — default values
// ---------------------------------------------------------------------------

test('getDefaultLimits returns correct default values when no env vars are set', () => {
  withEnv(
    {
      AUTOPILOT_MAX_CONTINUE: undefined,
      AUTOPILOT_MAX_REVIEW_FIX: undefined,
      AUTOPILOT_MAX_NETWORK_RETRY: undefined,
      AUTOPILOT_NETWORK_BACKOFF_MS_BASE: undefined,
      AUTOPILOT_TOOL_APPROVAL_TIMEOUT_MS: undefined,
      AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD: undefined,
    },
    () => {
      const limits = getDefaultLimits();
      assert.equal(limits.maxContinue, 5);
      assert.equal(limits.maxReviewFix, 5);
      assert.equal(limits.maxNetworkRetry, 3);
      assert.equal(limits.backoffBaseMs, 2000);
      assert.equal(limits.toolApprovalTimeoutMs, 0);
      assert.equal(limits.tokenBudgetExitThreshold, 0.2);
    },
  );
});

// ---------------------------------------------------------------------------
// getDefaultLimits — env var overrides
// ---------------------------------------------------------------------------

test('getDefaultLimits respects AUTOPILOT_MAX_CONTINUE env var', () => {
  withEnv({ AUTOPILOT_MAX_CONTINUE: '10' }, () => {
    assert.equal(getDefaultLimits().maxContinue, 10);
  });
});

test('getDefaultLimits respects AUTOPILOT_MAX_REVIEW_FIX env var', () => {
  withEnv({ AUTOPILOT_MAX_REVIEW_FIX: '8' }, () => {
    assert.equal(getDefaultLimits().maxReviewFix, 8);
  });
});

test('getDefaultLimits respects AUTOPILOT_MAX_NETWORK_RETRY env var', () => {
  withEnv({ AUTOPILOT_MAX_NETWORK_RETRY: '7' }, () => {
    assert.equal(getDefaultLimits().maxNetworkRetry, 7);
  });
});

test('getDefaultLimits respects AUTOPILOT_NETWORK_BACKOFF_MS_BASE env var', () => {
  withEnv({ AUTOPILOT_NETWORK_BACKOFF_MS_BASE: '5000' }, () => {
    assert.equal(getDefaultLimits().backoffBaseMs, 5000);
  });
});

test('getDefaultLimits respects AUTOPILOT_TOOL_APPROVAL_TIMEOUT_MS env var', () => {
  withEnv({ AUTOPILOT_TOOL_APPROVAL_TIMEOUT_MS: '30000' }, () => {
    assert.equal(getDefaultLimits().toolApprovalTimeoutMs, 30000);
  });
});

test('getDefaultLimits respects AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD env var', () => {
  withEnv({ AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD: '0.5' }, () => {
    assert.equal(getDefaultLimits().tokenBudgetExitThreshold, 0.5);
  });
});

// ---------------------------------------------------------------------------
// getDefaultLimits — NaN / invalid env var falls back to default
// ---------------------------------------------------------------------------

test('getDefaultLimits falls back to default when AUTOPILOT_MAX_CONTINUE is not a number', () => {
  withEnv({ AUTOPILOT_MAX_CONTINUE: 'not-a-number' }, () => {
    assert.equal(getDefaultLimits().maxContinue, 5);
  });
});

test('getDefaultLimits falls back to default when AUTOPILOT_MAX_REVIEW_FIX is empty string', () => {
  withEnv({ AUTOPILOT_MAX_REVIEW_FIX: '' }, () => {
    assert.equal(getDefaultLimits().maxReviewFix, 5);
  });
});

test('getDefaultLimits falls back to default when AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD is NaN', () => {
  withEnv({ AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD: 'abc' }, () => {
    assert.equal(getDefaultLimits().tokenBudgetExitThreshold, 0.2);
  });
});

test('getDefaultLimits falls back to default when AUTOPILOT_NETWORK_BACKOFF_MS_BASE is NaN', () => {
  withEnv({ AUTOPILOT_NETWORK_BACKOFF_MS_BASE: 'bad' }, () => {
    assert.equal(getDefaultLimits().backoffBaseMs, 2000);
  });
});

// ---------------------------------------------------------------------------
// mergeUserLimits
// ---------------------------------------------------------------------------

test('mergeUserLimits returns defaults unchanged when userOverrides is undefined', () => {
  const defaults = getDefaultLimits();
  const result = mergeUserLimits(defaults, undefined);
  assert.deepEqual(result, defaults);
});

test('mergeUserLimits returns defaults unchanged when userOverrides is empty object', () => {
  const defaults = getDefaultLimits();
  const result = mergeUserLimits(defaults, {});
  assert.deepEqual(result, defaults);
});

test('mergeUserLimits overrides only the specified fields', () => {
  const defaults: AutopilotLimits = {
    maxContinue: 5,
    maxReviewFix: 5,
    maxNetworkRetry: 3,
    backoffBaseMs: 2000,
    toolApprovalTimeoutMs: 0,
    tokenBudgetExitThreshold: 0.2,
  };
  const result = mergeUserLimits(defaults, { maxContinue: 10, maxReviewFix: 3 });

  assert.equal(result.maxContinue, 10);
  assert.equal(result.maxReviewFix, 3);
  // Unchanged fields stay at defaults
  assert.equal(result.maxNetworkRetry, 3);
  assert.equal(result.backoffBaseMs, 2000);
  assert.equal(result.toolApprovalTimeoutMs, 0);
  assert.equal(result.tokenBudgetExitThreshold, 0.2);
});

test('mergeUserLimits does not mutate the defaults object', () => {
  const defaults: AutopilotLimits = {
    maxContinue: 5,
    maxReviewFix: 5,
    maxNetworkRetry: 3,
    backoffBaseMs: 2000,
    toolApprovalTimeoutMs: 0,
    tokenBudgetExitThreshold: 0.2,
  };
  const originalMaxContinue = defaults.maxContinue;
  mergeUserLimits(defaults, { maxContinue: 99 });
  assert.equal(defaults.maxContinue, originalMaxContinue, 'defaults object must not be mutated');
});

test('mergeUserLimits with all fields overridden returns fully custom limits', () => {
  const defaults: AutopilotLimits = {
    maxContinue: 5,
    maxReviewFix: 5,
    maxNetworkRetry: 3,
    backoffBaseMs: 2000,
    toolApprovalTimeoutMs: 0,
    tokenBudgetExitThreshold: 0.2,
  };
  const overrides: AutopilotLimits = {
    maxContinue: 1,
    maxReviewFix: 2,
    maxNetworkRetry: 1,
    backoffBaseMs: 500,
    toolApprovalTimeoutMs: 10000,
    tokenBudgetExitThreshold: 0.5,
  };
  const result = mergeUserLimits(defaults, overrides);
  assert.deepEqual(result, overrides);
});

// ---------------------------------------------------------------------------
// DEFAULT_PROBE_PROMPT content assertions
// ---------------------------------------------------------------------------

test('DEFAULT_PROBE_PROMPT contains the literal string COMPLETED', () => {
  assert.ok(
    DEFAULT_PROBE_PROMPT.includes('COMPLETED'),
    `Expected DEFAULT_PROBE_PROMPT to contain "COMPLETED", got: ${DEFAULT_PROBE_PROMPT}`,
  );
});

test('DEFAULT_PROBE_PROMPT contains the literal string NOT_COMPLETED', () => {
  assert.ok(
    DEFAULT_PROBE_PROMPT.includes('NOT_COMPLETED'),
    `Expected DEFAULT_PROBE_PROMPT to contain "NOT_COMPLETED", got: ${DEFAULT_PROBE_PROMPT}`,
  );
});

test('DEFAULT_PROBE_PROMPT is a non-empty string', () => {
  assert.equal(typeof DEFAULT_PROBE_PROMPT, 'string');
  assert.ok(DEFAULT_PROBE_PROMPT.length > 0);
});

// ---------------------------------------------------------------------------
// DEFAULT_REVIEW_PROMPT content assertions
// ---------------------------------------------------------------------------

test('DEFAULT_REVIEW_PROMPT is a non-empty string', () => {
  assert.equal(typeof DEFAULT_REVIEW_PROMPT, 'string');
  assert.ok(DEFAULT_REVIEW_PROMPT.length > 0);
});

test('DEFAULT_REVIEW_PROMPT references JSON array format for findings', () => {
  assert.ok(
    DEFAULT_REVIEW_PROMPT.includes('JSON'),
    'DEFAULT_REVIEW_PROMPT should mention JSON format',
  );
});
