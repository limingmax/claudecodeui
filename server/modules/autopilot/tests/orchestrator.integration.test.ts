/**
 * Orchestrator integration tests.
 *
 * Architecture note: orchestrator.start() puts the session in EXECUTING but
 * does NOT call queryFn — the initial execute is driven externally by the
 * chat-websocket layer. Tests must manually call onSdkComplete/onSdkError.
 *
 * IMPORTANT: The orchestrator routes onSdkComplete based on currentPurpose,
 * which is set by setCurrentPurpose(). The mock queryFn must call
 * setCurrentPurpose(sessionId, purpose) before calling onSdkComplete so that
 * the routing (probe/review/fix vs execute) works correctly.
 *
 * IMPORTANT: After DONE/FAILED/CANCELLED the CLEANUP side effect removes the
 * session from the sessions Map. getSnapshot() returns null after cleanup.
 * waitForState() treats null as a terminal condition and returns the last
 * known snapshot captured from WS messages.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAutopilotOrchestrator } from '../services/orchestrator.service.js';
import { AutopilotState } from '../types.js';
import type { AutopilotSessionContext } from '../types.js';
import type { WebSocketWriter } from '@/modules/websocket/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(): WebSocketWriter & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    send(data: unknown) { messages.push(data); },
    messages,
  } as unknown as WebSocketWriter & { messages: unknown[] };
}

function kinds(messages: unknown[]): string[] {
  return messages
    .map((m) =>
      m && typeof m === 'object'
        ? ((m as Record<string, unknown>)['kind'] as string | undefined)
        : undefined,
    )
    .filter((k): k is string => typeof k === 'string');
}

/** Get the last state_changed 'to' value from WS messages. */
function lastState(messages: unknown[]): string | undefined {
  const changes = messages.filter(
    (m) =>
      m &&
      typeof m === 'object' &&
      (m as Record<string, unknown>)['kind'] === 'autopilot.state_changed',
  ) as Array<Record<string, unknown>>;
  return changes.length > 0 ? (changes[changes.length - 1]['to'] as string) : undefined;
}

/**
 * Wait until the orchestrator snapshot reaches one of the target states,
 * OR until the session is removed (null snapshot = CLEANUP ran = terminal).
 * Returns the last known state from WS messages when session is removed.
 */
async function waitForState(
  sessionId: string,
  ws: WebSocketWriter & { messages: unknown[] },
  targets: AutopilotState[],
  timeoutMs = 5000,
): Promise<string> {
  const orchestrator = getAutopilotOrchestrator();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = orchestrator.getSnapshot(sessionId);
    if (snap && targets.includes(snap.state)) {
      return snap.state;
    }
    // Session removed = CLEANUP ran = terminal state reached
    if (snap === null) {
      // Return the last state from WS messages
      return lastState(ws.messages) ?? 'null';
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  const snap = orchestrator.getSnapshot(sessionId);
  const last = lastState(ws.messages);
  throw new Error(
    `Timed out waiting for [${targets.join(',')}]. Snapshot: ${snap?.state ?? 'null'}, last WS state: ${last}`,
  );
}

/** Wait until session is removed (CLEANUP ran) or reaches a terminal state. */
async function waitForTerminal(
  sessionId: string,
  ws: WebSocketWriter & { messages: unknown[] },
  timeoutMs = 4000,
): Promise<string> {
  return waitForState(
    sessionId,
    ws,
    [AutopilotState.DONE, AutopilotState.FAILED, AutopilotState.CANCELLED],
    timeoutMs,
  );
}

let _seq = 0;
function nextId(): string {
  return `oi-${Date.now()}-${++_seq}`;
}

async function noop() {}

function makeOpts(overrides: {
  reviewFix?: boolean;
  commit?: boolean;
  maxContinue?: number;
  maxNetworkRetry?: number;
  backoffBaseMs?: number;
} = {}) {
  return {
    toggles: {
      execution: false,
      reviewFix: overrides.reviewFix ?? false,
      commit: overrides.commit ?? false,
    },
    limits: {
      maxContinue: overrides.maxContinue ?? 5,
      maxReviewFix: 5,
      maxNetworkRetry: overrides.maxNetworkRetry ?? 3,
      backoffBaseMs: overrides.backoffBaseMs ?? 1,
      toolApprovalTimeoutMs: 0,
      tokenBudgetExitThreshold: 0.2,
    },
    cwd: process.cwd(),
    cleanup: noop,
  };
}

/**
 * Detect the purpose of a RESUME_QUERY call from its prompt text.
 * The probe prompt contains the literal word COMPLETED.
 * The continue prompt is exactly '继续'.
 * The review prompt contains '评审'.
 * Everything else is a fix prompt.
 */
function detectPurpose(
  prompt: string,
): 'probe' | 'continue' | 'review' | 'fix' {
  if (prompt.includes('COMPLETED') || prompt.includes('已完成')) return 'probe';
  if (prompt === '继续') return 'continue';
  // Fix prompts contain '修复' — must check before '评审'/'review' because
  // buildFixPrompt outputs '请修复以下 review findings' which contains 'review'.
  if (prompt.includes('修复')) return 'fix';
  if (prompt.includes('评审') || prompt.includes('review')) return 'review';
  return 'fix';
}

// ---------------------------------------------------------------------------
// Sequential suite — avoids singleton _queryFn contamination between tests
// ---------------------------------------------------------------------------

describe('orchestrator integration', { concurrency: false }, () => {

  // -------------------------------------------------------------------------
  // T1: complete happy path
  // -------------------------------------------------------------------------

  it('complete happy path: execute → probe COMPLETED → DONE', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      // New contract: write assistant text to ws so capturingWs captures it;
      // executor calls onSdkComplete after queryFn resolves.
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'COMPLETED' });
      }
      // For non-probe turns empty text is fine — executor calls onSdkComplete('').
    });

    orchestrator.start(sessionId, makeOpts(), ws);

    // Wait until EXECUTING (session exists)
    const orchestratorRef = orchestrator;
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      const s = orchestratorRef.getSnapshot(sessionId);
      if (s?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Trigger initial execute completion (initial turn is driven externally).
    orchestrator.onSdkComplete(sessionId, '');

    const finalState = await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED]);
    assert.equal(finalState, AutopilotState.DONE);
    const k = kinds(ws.messages);
    assert.ok(k.includes('autopilot.state_changed'));
    assert.ok(k.includes('autopilot.completed'));
  });

  // -------------------------------------------------------------------------
  // T2: probe NOT_COMPLETED once → continue +1 → COMPLETED → DONE
  // -------------------------------------------------------------------------

  it('probe NOT_COMPLETED once increments continue counter then reaches DONE', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();
    let probeCount = 0;

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        probeCount++;
        ws.send({ kind: 'text', content: probeCount === 1 ? 'NOT_COMPLETED' : 'COMPLETED' });
      }
      // continue/other: empty text — executor calls onSdkComplete('').
    });

    orchestrator.start(sessionId, makeOpts(), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    orchestrator.onSdkComplete(sessionId, '');

    const finalState = await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED], 8000);
    assert.equal(finalState, AutopilotState.DONE);

    // Check continue counter from WS messages (session already removed)
    const stateChanges = ws.messages.filter(
      (m) =>
        m &&
        typeof m === 'object' &&
        (m as Record<string, unknown>)['kind'] === 'autopilot.state_changed',
    ) as Array<Record<string, unknown>>;
    const toStates = stateChanges.map((m) => m['to'] as string);
    // Should have gone through EXECUTING twice (initial + after NOT_COMPLETED)
    assert.ok(
      toStates.filter((s) => s === AutopilotState.EXECUTING).length >= 2,
      `expected EXECUTING at least twice, got: ${toStates.join(',')}`,
    );
  });

  // -------------------------------------------------------------------------
  // T3: probe NOT_COMPLETED until maxContinue → DONE + limit_reached
  // -------------------------------------------------------------------------

  it('probe NOT_COMPLETED until maxContinue forces DONE with limit_reached', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'NOT_COMPLETED' });
      }
    });

    orchestrator.start(sessionId, makeOpts({ maxContinue: 2 }), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    orchestrator.onSdkComplete(sessionId, '');

    const finalState = await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED], 8000);
    assert.equal(finalState, AutopilotState.DONE);
    const k = kinds(ws.messages);
    assert.ok(k.includes('autopilot.limit_reached'));
    assert.ok(k.includes('autopilot.completed'));
  });

  // -------------------------------------------------------------------------
  // T4: network error → RETRY_NETWORK → retry → DONE
  // -------------------------------------------------------------------------

  it('network error goes through RETRY_NETWORK then retries and reaches DONE', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();
    let continueCount = 0;

    orchestrator.setQueryFn(async (prompt, opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'COMPLETED' });
      } else if (p === 'continue') {
        continueCount++;
        if (continueCount === 1) {
          // Simulate network error: throw so executor catches and enqueues sdk_error.
          throw new Error('ECONNRESET');
        }
        // Second continue: empty text → executor calls onSdkComplete('').
      }
    });

    orchestrator.start(sessionId, makeOpts({ backoffBaseMs: 1 }), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Trigger initial network error
    orchestrator.onSdkError(sessionId, new Error('ECONNRESET'));

    const finalState = await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED], 8000);

    const toStates = (ws.messages as Array<Record<string, unknown>>)
      .filter((m) => m['kind'] === 'autopilot.state_changed')
      .map((m) => m['to'] as string);
    assert.ok(
      toStates.includes(AutopilotState.RETRY_NETWORK),
      `expected RETRY_NETWORK, got: ${toStates.join(',')}`,
    );
    assert.equal(finalState, AutopilotState.DONE);
  });

  // -------------------------------------------------------------------------
  // T5: business error → FAILED + autopilot.failed
  // -------------------------------------------------------------------------

  it('business error transitions to FAILED and emits autopilot.failed', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (_prompt, _opts, _ws) => {
      // no-op — initial execute is driven manually
    });

    orchestrator.start(sessionId, makeOpts(), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    orchestrator.onSdkError(sessionId, new Error('unexpected business failure'));

    const finalState = await waitForState(sessionId, ws, [AutopilotState.FAILED, AutopilotState.DONE]);
    assert.equal(finalState, AutopilotState.FAILED);
    assert.ok(kinds(ws.messages).includes('autopilot.failed'));
  });

  // -------------------------------------------------------------------------
  // T6: review high finding → FIXING → REVIEWING again (reviewFix=true)
  // -------------------------------------------------------------------------

  it('review high finding triggers FIXING then returns to REVIEWING', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();
    let reviewCount = 0;

    const highFinding = JSON.stringify([
      { id: 'f1', severity: 'high', message: 'security issue' },
    ]);

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'COMPLETED' });
      } else if (p === 'review') {
        reviewCount++;
        ws.send({ kind: 'text', content: reviewCount === 1 ? highFinding : '[]' });
      }
      // fix/other: empty text — executor calls onSdkComplete('').
    });

    orchestrator.start(sessionId, makeOpts({ reviewFix: true }), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    orchestrator.onSdkComplete(sessionId, '');

    await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED], 10000);

    const toStates = (ws.messages as Array<Record<string, unknown>>)
      .filter((m) => m['kind'] === 'autopilot.state_changed')
      .map((m) => m['to'] as string);

    assert.ok(
      toStates.includes(AutopilotState.FIXING),
      `expected FIXING, got: ${toStates.join(',')}`,
    );
    assert.ok(
      toStates.filter((s) => s === AutopilotState.REVIEWING).length >= 2,
      'should enter REVIEWING at least twice',
    );
  });

  // -------------------------------------------------------------------------
  // T7: review only low findings → review_pass → DONE
  // -------------------------------------------------------------------------

  it('review with only low findings emits review_pass and reaches DONE', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'COMPLETED' });
      } else if (p === 'review') {
        ws.send({ kind: 'text', content: JSON.stringify([{ id: 'l1', severity: 'low', message: 'style' }]) });
      }
    });

    orchestrator.start(sessionId, makeOpts({ reviewFix: true, commit: false }), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    orchestrator.onSdkComplete(sessionId, '');

    const finalState = await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED], 8000);
    assert.equal(finalState, AutopilotState.DONE);
    assert.ok(kinds(ws.messages).includes('autopilot.completed'));
  });

  // -------------------------------------------------------------------------
  // T8: review dead loop (same findings twice) → DONE
  // -------------------------------------------------------------------------

  it('review dead loop with same findings twice forces DONE', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    const sameFinding = JSON.stringify([
      { id: 'stuck1', severity: 'high', message: 'same issue' },
    ]);

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'COMPLETED' });
      } else if (p === 'review') {
        ws.send({ kind: 'text', content: sameFinding });
      }
      // fix/other: empty text — executor calls onSdkComplete('').
    });

    orchestrator.start(sessionId, makeOpts({ reviewFix: true }), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    orchestrator.onSdkComplete(sessionId, '');

    const finalState = await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED], 10000);
    assert.equal(finalState, AutopilotState.DONE);
    assert.ok(kinds(ws.messages).includes('autopilot.limit_reached'));
  });

  // -------------------------------------------------------------------------
  // T9: state_changed events appear in correct order for happy path
  // -------------------------------------------------------------------------

  it('ws.send state_changed events appear in correct order for happy path', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'COMPLETED' });
      }
    });

    orchestrator.start(sessionId, makeOpts(), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    orchestrator.onSdkComplete(sessionId, '');

    await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED]);

    const toStates = (ws.messages as Array<Record<string, unknown>>)
      .filter((m) => m['kind'] === 'autopilot.state_changed')
      .map((m) => m['to'] as string);

    assert.ok(
      toStates.length >= 3,
      `expected >= 3 transitions, got ${toStates.length}: ${toStates.join(',')}`,
    );
    assert.equal(toStates[0], AutopilotState.EXECUTING);
    assert.ok(toStates.includes(AutopilotState.COMPLETION_PROBE));
    assert.equal(toStates[toStates.length - 1], AutopilotState.DONE);
  });

  // -------------------------------------------------------------------------
  // T10: getSnapshot returns current snapshot with state and counters
  // -------------------------------------------------------------------------

  it('getSnapshot returns current snapshot with state and counters while session active', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'COMPLETED' });
      }
    });

    orchestrator.start(sessionId, makeOpts(), ws);

    // Wait until EXECUTING (session exists and is active)
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Inspect snapshot while in EXECUTING (before triggering completion)
    const snap = orchestrator.getSnapshot(sessionId);
    assert.ok(snap !== null);
    assert.equal(snap!.state, AutopilotState.EXECUTING);
    assert.ok('counters' in snap!);
    assert.ok('toggles' in snap!);

    // Drive to completion
    orchestrator.onSdkComplete(sessionId, '');
    await waitForState(sessionId, ws, [AutopilotState.DONE, AutopilotState.FAILED]);
  });

  // -------------------------------------------------------------------------
  // T11: review pass with commit=true → passes through COMMITTING state
  // -------------------------------------------------------------------------

  it('review pass with commit=true passes through COMMITTING state', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (prompt, _opts, ws) => {
      const p = detectPurpose(prompt);
      if (p === 'probe') {
        ws.send({ kind: 'text', content: 'COMPLETED' });
      } else if (p === 'review') {
        ws.send({ kind: 'text', content: '[]' });
      }
      // commit turn: empty text — executor calls onSdkComplete('').
    });

    orchestrator.start(sessionId, makeOpts({ reviewFix: true, commit: true }), ws);
    const deadline0 = Date.now() + 2000;
    while (Date.now() < deadline0) {
      if (orchestrator.getSnapshot(sessionId)?.state === AutopilotState.EXECUTING) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    orchestrator.onSdkComplete(sessionId, '');

    await waitForState(
      sessionId,
      ws,
      [AutopilotState.DONE, AutopilotState.FAILED, AutopilotState.COMMITTING],
      10000,
    );

    const toStates = (ws.messages as Array<Record<string, unknown>>)
      .filter((m) => m['kind'] === 'autopilot.state_changed')
      .map((m) => m['to'] as string);

    assert.ok(
      toStates.includes(AutopilotState.COMMITTING) || toStates.includes(AutopilotState.DONE),
      `expected COMMITTING or DONE, got: ${toStates.join(',')}`,
    );
  });

});
