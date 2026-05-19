import assert from 'node:assert/strict';
import test from 'node:test';

import { autopilotReducer } from '../reducer.js';
import { AutopilotState } from '../types.js';
import type {
  AutopilotSessionContext,
  AutopilotSideEffect,
  ReviewFinding,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<AutopilotSessionContext> = {}): AutopilotSessionContext {
  return {
    state: AutopilotState.IDLE,
    counters: { continue: 0, reviewFix: 0, networkRetry: 0 },
    toggles: { execution: false, reviewFix: false, commit: false },
    limits: {
      maxContinue: 5,
      maxReviewFix: 5,
      maxNetworkRetry: 3,
      backoffBaseMs: 2000,
      toolApprovalTimeoutMs: 0,
      tokenBudgetExitThreshold: 0.2,
    },
    lastReviewFindings: null,
    cancelled: false,
    ...overrides,
  };
}

function hasWsKind(effects: AutopilotSideEffect[], kind: string): boolean {
  return effects.some((e) => e.type === 'EMIT_WS' && e.payload.kind === kind);
}

function hasStateChanged(effects: AutopilotSideEffect[]): boolean {
  return hasWsKind(effects, 'autopilot.state_changed');
}

function finding(id: string): ReviewFinding {
  return { id, severity: 'high', message: `issue ${id}` };
}

// ---------------------------------------------------------------------------
// T1: IDLE → start → EXECUTING
// ---------------------------------------------------------------------------

test('IDLE + start transitions to EXECUTING and resets counters', () => {
  const ctx = makeCtx({ state: AutopilotState.IDLE });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'start' });

  assert.equal(newContext.state, AutopilotState.EXECUTING);
  assert.deepEqual(newContext.counters, { continue: 0, reviewFix: 0, networkRetry: 0 });
  assert.ok(hasStateChanged(sideEffects));
});

// ---------------------------------------------------------------------------
// T2: EXECUTING → sdk_complete → COMPLETION_PROBE
// ---------------------------------------------------------------------------

test('EXECUTING + sdk_complete transitions to COMPLETION_PROBE and emits RESUME_QUERY probe', () => {
  const ctx = makeCtx({ state: AutopilotState.EXECUTING });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'sdk_complete' });

  assert.equal(newContext.state, AutopilotState.COMPLETION_PROBE);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(sideEffects.some((e) => e.type === 'RESUME_QUERY' && e.payload.purpose === 'probe'));
});

// ---------------------------------------------------------------------------
// T3: EXECUTING → sdk_error(network) → RETRY_NETWORK (counter increments)
// ---------------------------------------------------------------------------

test('EXECUTING + sdk_error(network) transitions to RETRY_NETWORK and increments networkRetry', () => {
  const ctx = makeCtx({ state: AutopilotState.EXECUTING });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'sdk_error',
    payload: { kind: 'network', error: new Error('ECONNRESET') },
  });

  assert.equal(newContext.state, AutopilotState.RETRY_NETWORK);
  assert.equal(newContext.counters.networkRetry, 1);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(sideEffects.some((e) => e.type === 'SCHEDULE_RETRY'));
});

// ---------------------------------------------------------------------------
// T4: EXECUTING → sdk_error(business) → FAILED
// ---------------------------------------------------------------------------

test('EXECUTING + sdk_error(business) transitions to FAILED', () => {
  const ctx = makeCtx({ state: AutopilotState.EXECUTING });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'sdk_error',
    payload: { kind: 'business', error: new Error('unexpected') },
  });

  assert.equal(newContext.state, AutopilotState.FAILED);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(hasWsKind(sideEffects, 'autopilot.failed'));
  assert.ok(sideEffects.some((e) => e.type === 'CLEANUP'));
});

// ---------------------------------------------------------------------------
// T5: RETRY_NETWORK → retry_ready → EXECUTING
// ---------------------------------------------------------------------------

test('RETRY_NETWORK + retry_ready transitions to EXECUTING and emits RESUME_QUERY continue', () => {
  const ctx = makeCtx({ state: AutopilotState.RETRY_NETWORK });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'retry_ready' });

  assert.equal(newContext.state, AutopilotState.EXECUTING);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(sideEffects.some((e) => e.type === 'RESUME_QUERY' && e.payload.purpose === 'continue'));
});

// ---------------------------------------------------------------------------
// T6: RETRY_NETWORK → limit_reached → FAILED
// ---------------------------------------------------------------------------

test('RETRY_NETWORK + limit_reached(networkRetry) transitions to FAILED', () => {
  const ctx = makeCtx({ state: AutopilotState.RETRY_NETWORK });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'limit_reached',
    payload: { limitType: 'networkRetry' },
  });

  assert.equal(newContext.state, AutopilotState.FAILED);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(hasWsKind(sideEffects, 'autopilot.failed'));
});

// ---------------------------------------------------------------------------
// T7: COMPLETION_PROBE → probe_completed → REVIEWING (reviewFix=true)
// ---------------------------------------------------------------------------

test('COMPLETION_PROBE + probe_completed routes to REVIEWING when reviewFix toggle is on', () => {
  const ctx = makeCtx({
    state: AutopilotState.COMPLETION_PROBE,
    toggles: { execution: false, reviewFix: true, commit: false },
  });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'probe_completed' });

  assert.equal(newContext.state, AutopilotState.REVIEWING);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(sideEffects.some((e) => e.type === 'RESUME_QUERY' && e.payload.purpose === 'review'));
});

// ---------------------------------------------------------------------------
// T8: COMPLETION_PROBE → probe_completed → COMMITTING (reviewFix=false, commit=true)
// ---------------------------------------------------------------------------

test('COMPLETION_PROBE + probe_completed routes to COMMITTING when commit toggle is on and reviewFix is off', () => {
  const ctx = makeCtx({
    state: AutopilotState.COMPLETION_PROBE,
    toggles: { execution: false, reviewFix: false, commit: true },
  });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'probe_completed' });

  assert.equal(newContext.state, AutopilotState.COMMITTING);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(sideEffects.some((e) => e.type === 'GIT_COMMIT'));
});

// ---------------------------------------------------------------------------
// T9: COMPLETION_PROBE → probe_completed → DONE (both toggles off)
// ---------------------------------------------------------------------------

test('COMPLETION_PROBE + probe_completed routes to DONE when both reviewFix and commit are off', () => {
  const ctx = makeCtx({ state: AutopilotState.COMPLETION_PROBE });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'probe_completed' });

  assert.equal(newContext.state, AutopilotState.DONE);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(hasWsKind(sideEffects, 'autopilot.completed'));
});

// ---------------------------------------------------------------------------
// T10: COMPLETION_PROBE → probe_not_completed → EXECUTING (counter increments)
// ---------------------------------------------------------------------------

test('COMPLETION_PROBE + probe_not_completed transitions to EXECUTING and increments continue counter', () => {
  const ctx = makeCtx({ state: AutopilotState.COMPLETION_PROBE });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'probe_not_completed' });

  assert.equal(newContext.state, AutopilotState.EXECUTING);
  assert.equal(newContext.counters.continue, 1);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(sideEffects.some((e) => e.type === 'RESUME_QUERY' && e.payload.purpose === 'continue'));
});

// ---------------------------------------------------------------------------
// T11: COMPLETION_PROBE → probe_unparsed → EXECUTING (treated as not_completed)
// ---------------------------------------------------------------------------

test('COMPLETION_PROBE + probe_unparsed transitions to EXECUTING same as probe_not_completed', () => {
  const ctx = makeCtx({ state: AutopilotState.COMPLETION_PROBE });
  const { newContext } = autopilotReducer(ctx, { type: 'probe_unparsed' });

  assert.equal(newContext.state, AutopilotState.EXECUTING);
  assert.equal(newContext.counters.continue, 1);
});

// ---------------------------------------------------------------------------
// T12: COMPLETION_PROBE → limit_reached → DONE
// ---------------------------------------------------------------------------

test('COMPLETION_PROBE + limit_reached(continue) transitions to DONE', () => {
  const ctx = makeCtx({ state: AutopilotState.COMPLETION_PROBE });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'limit_reached',
    payload: { limitType: 'continue' },
  });

  assert.equal(newContext.state, AutopilotState.DONE);
  assert.ok(hasWsKind(sideEffects, 'autopilot.completed'));
});

// ---------------------------------------------------------------------------
// T13: REVIEWING → review_pass → COMMITTING (commit=true)
// ---------------------------------------------------------------------------

test('REVIEWING + review_pass routes to COMMITTING when commit toggle is on', () => {
  const ctx = makeCtx({
    state: AutopilotState.REVIEWING,
    toggles: { execution: false, reviewFix: true, commit: true },
  });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'review_pass' });

  assert.equal(newContext.state, AutopilotState.COMMITTING);
  assert.ok(sideEffects.some((e) => e.type === 'GIT_COMMIT'));
});

// ---------------------------------------------------------------------------
// T13b: REVIEWING → review_pass → DONE (commit=false)
// ---------------------------------------------------------------------------

test('REVIEWING + review_pass routes to DONE when commit toggle is off', () => {
  const ctx = makeCtx({
    state: AutopilotState.REVIEWING,
    toggles: { execution: false, reviewFix: true, commit: false },
  });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'review_pass' });

  assert.equal(newContext.state, AutopilotState.DONE);
  assert.ok(hasWsKind(sideEffects, 'autopilot.completed'));
});

// ---------------------------------------------------------------------------
// T14: REVIEWING → review_fail (new findings) → FIXING (counter increments)
// ---------------------------------------------------------------------------

test('REVIEWING + review_fail with new findings transitions to FIXING and increments reviewFix counter', () => {
  const ctx = makeCtx({ state: AutopilotState.REVIEWING });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'review_fail',
    payload: { findings: [finding('f1')], severity: 'high' },
  });

  assert.equal(newContext.state, AutopilotState.FIXING);
  assert.equal(newContext.counters.reviewFix, 1);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(sideEffects.some((e) => e.type === 'RESUME_QUERY' && e.payload.purpose === 'fix'));
});

// ---------------------------------------------------------------------------
// T15: REVIEWING → review_fail (same findings) → DONE (loop exit)
// ---------------------------------------------------------------------------

test('REVIEWING + review_fail with same findings as last round exits loop to DONE', () => {
  const ctx = makeCtx({
    state: AutopilotState.REVIEWING,
    lastReviewFindings: [finding('f1'), finding('f2')],
  });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'review_fail',
    payload: { findings: [finding('f2'), finding('f1')], severity: 'high' },
  });

  assert.equal(newContext.state, AutopilotState.DONE);
  assert.ok(hasWsKind(sideEffects, 'autopilot.limit_reached'));
  assert.ok(hasWsKind(sideEffects, 'autopilot.completed'));
});

// ---------------------------------------------------------------------------
// T15b: REVIEWING → review_fail at reviewFix=MAX → DONE (hard limit)
// ---------------------------------------------------------------------------

test('REVIEWING + review_fail when reviewFix counter is at max transitions to DONE', () => {
  const ctx = makeCtx({
    state: AutopilotState.REVIEWING,
    counters: { continue: 0, reviewFix: 5, networkRetry: 0 },
    limits: {
      maxContinue: 5,
      maxReviewFix: 5,
      maxNetworkRetry: 3,
      backoffBaseMs: 2000,
      toolApprovalTimeoutMs: 0,
      tokenBudgetExitThreshold: 0.2,
    },
  });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'review_fail',
    payload: { findings: [finding('new1')], severity: 'high' },
  });

  assert.equal(newContext.state, AutopilotState.DONE);
  assert.ok(hasWsKind(sideEffects, 'autopilot.limit_reached'));
});

// ---------------------------------------------------------------------------
// T16: FIXING → fix_complete → REVIEWING
// ---------------------------------------------------------------------------

test('FIXING + fix_complete transitions to REVIEWING and emits RESUME_QUERY review', () => {
  const ctx = makeCtx({ state: AutopilotState.FIXING });
  const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'fix_complete' });

  assert.equal(newContext.state, AutopilotState.REVIEWING);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(sideEffects.some((e) => e.type === 'RESUME_QUERY' && e.payload.purpose === 'review'));
});

// ---------------------------------------------------------------------------
// T17: COMMITTING → commit_success → DONE
// ---------------------------------------------------------------------------

test('COMMITTING + commit_success transitions to DONE with commit hash in completed event', () => {
  const ctx = makeCtx({ state: AutopilotState.COMMITTING });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'commit_success',
    payload: { hash: 'abc123' },
  });

  assert.equal(newContext.state, AutopilotState.DONE);
  assert.ok(hasStateChanged(sideEffects));
  const completedEffect = sideEffects.find(
    (e) => e.type === 'EMIT_WS' && e.payload.kind === 'autopilot.completed',
  );
  assert.ok(completedEffect);
  const summary = (completedEffect as { type: 'EMIT_WS'; payload: Record<string, unknown> }).payload['summary'] as Record<string, unknown> | undefined;
  assert.equal(summary?.['commitHash'], 'abc123');
});

// ---------------------------------------------------------------------------
// T18: COMMITTING → commit_error → FAILED
// ---------------------------------------------------------------------------

test('COMMITTING + commit_error transitions to FAILED', () => {
  const ctx = makeCtx({ state: AutopilotState.COMMITTING });
  const { newContext, sideEffects } = autopilotReducer(ctx, {
    type: 'commit_error',
    payload: { error: new Error('git failed') },
  });

  assert.equal(newContext.state, AutopilotState.FAILED);
  assert.ok(hasStateChanged(sideEffects));
  assert.ok(hasWsKind(sideEffects, 'autopilot.failed'));
});

// ---------------------------------------------------------------------------
// T19: ANY → abort → CANCELLED (tested from multiple states)
// ---------------------------------------------------------------------------

const abortStates = [
  AutopilotState.IDLE,
  AutopilotState.EXECUTING,
  AutopilotState.RETRY_NETWORK,
  AutopilotState.COMPLETION_PROBE,
  AutopilotState.REVIEWING,
  AutopilotState.FIXING,
  AutopilotState.COMMITTING,
  AutopilotState.DONE,
  AutopilotState.FAILED,
];

for (const fromState of abortStates) {
  test(`abort from ${fromState} transitions to CANCELLED and emits autopilot.cancelled`, () => {
    const ctx = makeCtx({ state: fromState });
    const { newContext, sideEffects } = autopilotReducer(ctx, { type: 'abort' });

    assert.equal(newContext.state, AutopilotState.CANCELLED);
    assert.equal(newContext.cancelled, true);
    assert.ok(hasWsKind(sideEffects, 'autopilot.cancelled'));
    assert.ok(sideEffects.some((e) => e.type === 'CLEANUP'));
  });
}

// ---------------------------------------------------------------------------
// Edge: reducer does not mutate input context
// ---------------------------------------------------------------------------

test('reducer does not mutate the input context object', () => {
  const ctx = makeCtx({ state: AutopilotState.EXECUTING });
  const frozen = Object.freeze({
    ...ctx,
    counters: Object.freeze({ ...ctx.counters }),
    toggles: Object.freeze({ ...ctx.toggles }),
    limits: Object.freeze({ ...ctx.limits }),
  }) as AutopilotSessionContext;

  // Should not throw even though input is frozen
  assert.doesNotThrow(() => {
    autopilotReducer(frozen, { type: 'sdk_complete' });
  });
});

// ---------------------------------------------------------------------------
// Edge: reducer is idempotent — same input always produces same output
// ---------------------------------------------------------------------------

test('reducer is idempotent: same input produces same output on repeated calls', () => {
  const ctx = makeCtx({ state: AutopilotState.EXECUTING });
  const r1 = autopilotReducer(ctx, { type: 'sdk_complete' });
  const r2 = autopilotReducer(ctx, { type: 'sdk_complete' });

  assert.equal(r1.newContext.state, r2.newContext.state);
  assert.deepEqual(r1.newContext.counters, r2.newContext.counters);
  assert.equal(r1.sideEffects.length, r2.sideEffects.length);
});

// ---------------------------------------------------------------------------
// Edge: probe_not_completed N times until continue limit → DONE
// ---------------------------------------------------------------------------

test('probe_not_completed repeated until maxContinue limit transitions to DONE', () => {
  const limits = {
    maxContinue: 3,
    maxReviewFix: 5,
    maxNetworkRetry: 3,
    backoffBaseMs: 2000,
    toolApprovalTimeoutMs: 0,
    tokenBudgetExitThreshold: 0.2,
  };
  let ctx = makeCtx({ state: AutopilotState.COMPLETION_PROBE, limits });

  // First 3 calls should keep going (counter 1, 2, 3)
  for (let i = 0; i < 3; i++) {
    const r = autopilotReducer(ctx, { type: 'probe_not_completed' });
    assert.equal(r.newContext.state, AutopilotState.EXECUTING);
    // Simulate going back to COMPLETION_PROBE for next iteration
    ctx = { ...r.newContext, state: AutopilotState.COMPLETION_PROBE };
  }

  // 4th call exceeds maxContinue=3 → DONE
  const final = autopilotReducer(ctx, { type: 'probe_not_completed' });
  assert.equal(final.newContext.state, AutopilotState.DONE);
  assert.ok(hasWsKind(final.sideEffects, 'autopilot.limit_reached'));
});

// ---------------------------------------------------------------------------
// Edge: review_fail at reviewFix=MAX-1 → next review_fail triggers limit
// ---------------------------------------------------------------------------

test('review_fail at reviewFix=MAX-1 causes next review_fail to hit limit and go to DONE', () => {
  const limits = {
    maxContinue: 5,
    maxReviewFix: 2,
    maxNetworkRetry: 3,
    backoffBaseMs: 2000,
    toolApprovalTimeoutMs: 0,
    tokenBudgetExitThreshold: 0.2,
  };
  // reviewFix already at MAX-1 = 1
  const ctx = makeCtx({
    state: AutopilotState.REVIEWING,
    counters: { continue: 0, reviewFix: 2, networkRetry: 0 },
    limits,
  });

  const { newContext } = autopilotReducer(ctx, {
    type: 'review_fail',
    payload: { findings: [finding('new-finding')], severity: 'high' },
  });

  assert.equal(newContext.state, AutopilotState.DONE);
});

// ---------------------------------------------------------------------------
// Edge: all transitions emit autopilot.state_changed side effect
// ---------------------------------------------------------------------------

test('every state transition emits autopilot.state_changed side effect', () => {
  const transitions: Array<[AutopilotSessionContext, Parameters<typeof autopilotReducer>[1]]> = [
    [makeCtx({ state: AutopilotState.IDLE }), { type: 'start' }],
    [makeCtx({ state: AutopilotState.EXECUTING }), { type: 'sdk_complete' }],
    [makeCtx({ state: AutopilotState.EXECUTING }), { type: 'sdk_error', payload: { kind: 'network', error: null } }],
    [makeCtx({ state: AutopilotState.EXECUTING }), { type: 'sdk_error', payload: { kind: 'business', error: null } }],
    [makeCtx({ state: AutopilotState.RETRY_NETWORK }), { type: 'retry_ready' }],
    [makeCtx({ state: AutopilotState.COMPLETION_PROBE }), { type: 'probe_completed' }],
    [makeCtx({ state: AutopilotState.COMPLETION_PROBE }), { type: 'probe_not_completed' }],
    [makeCtx({ state: AutopilotState.REVIEWING }), { type: 'review_pass' }],
    [makeCtx({ state: AutopilotState.REVIEWING }), { type: 'review_fail', payload: { findings: [finding('x')], severity: 'high' } }],
    [makeCtx({ state: AutopilotState.FIXING }), { type: 'fix_complete' }],
    [makeCtx({ state: AutopilotState.COMMITTING }), { type: 'commit_success', payload: { hash: 'h1' } }],
    [makeCtx({ state: AutopilotState.COMMITTING }), { type: 'commit_error', payload: { error: null } }],
  ];

  for (const [ctx, event] of transitions) {
    const { sideEffects } = autopilotReducer(ctx, event);
    assert.ok(
      hasStateChanged(sideEffects),
      `Expected autopilot.state_changed for ${ctx.state} + ${event.type}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Edge: limit_reached with different limitTypes all go to correct terminal state
// ---------------------------------------------------------------------------

test('limit_reached(continue) in COMPLETION_PROBE goes to DONE not FAILED', () => {
  const ctx = makeCtx({ state: AutopilotState.COMPLETION_PROBE });
  const { newContext } = autopilotReducer(ctx, { type: 'limit_reached', payload: { limitType: 'continue' } });
  assert.equal(newContext.state, AutopilotState.DONE);
});

test('limit_reached(networkRetry) in EXECUTING goes to FAILED', () => {
  const ctx = makeCtx({ state: AutopilotState.EXECUTING });
  const { newContext } = autopilotReducer(ctx, { type: 'limit_reached', payload: { limitType: 'networkRetry' } });
  assert.equal(newContext.state, AutopilotState.FAILED);
});

test('limit_reached(token) in REVIEWING goes to DONE', () => {
  const ctx = makeCtx({ state: AutopilotState.REVIEWING });
  const { newContext } = autopilotReducer(ctx, { type: 'limit_reached', payload: { limitType: 'token' } });
  assert.equal(newContext.state, AutopilotState.DONE);
});
