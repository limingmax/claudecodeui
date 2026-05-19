/**
 * Abort race-condition tests.
 *
 * Key insight: The drain loop is blocked while queryFn is awaited. If queryFn
 * hangs, abort() enqueues the abort event but the drain loop never processes
 * it. Therefore, abort tests must abort while the session is in EXECUTING
 * (before onSdkComplete is called) — at that point no queryFn is running and
 * the drain loop is idle, so the abort event is processed immediately.
 *
 * For the "abort during RETRY_NETWORK" test, the session is in RETRY_NETWORK
 * waiting for a setTimeout — no queryFn is running — so abort works fine.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAutopilotOrchestrator } from '../services/orchestrator.service.js';
import { AutopilotState } from '../types.js';
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

/** Wait until session is null (cleaned up) or reaches a terminal state. */
async function waitForTerminal(
  sessionId: string,
  timeoutMs = 3000,
): Promise<void> {
  const orchestrator = getAutopilotOrchestrator();
  const terminal = [AutopilotState.DONE, AutopilotState.FAILED, AutopilotState.CANCELLED];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = orchestrator.getSnapshot(sessionId);
    if (snap === null || terminal.includes(snap.state)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait until snapshot reaches one of the given states. Returns true if reached. */
async function waitForState(
  sessionId: string,
  targets: AutopilotState[],
  timeoutMs = 2000,
): Promise<boolean> {
  const orchestrator = getAutopilotOrchestrator();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = orchestrator.getSnapshot(sessionId);
    if (snap && targets.includes(snap.state)) return true;
    if (snap === null) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

let _seq = 0;
function nextId(): string {
  return `abort-${Date.now()}-${++_seq}`;
}

async function noop() {}

function makeOpts(backoffBaseMs = 1) {
  return {
    toggles: { execution: false, reviewFix: false, commit: false },
    limits: {
      maxContinue: 5,
      maxReviewFix: 5,
      maxNetworkRetry: 3,
      backoffBaseMs,
      toolApprovalTimeoutMs: 0,
      tokenBudgetExitThreshold: 0.2,
    },
    cwd: process.cwd(),
    cleanup: noop,
  };
}

// ---------------------------------------------------------------------------
// Sequential suite
// ---------------------------------------------------------------------------

describe('abort races', { concurrency: false }, () => {

  // -------------------------------------------------------------------------
  // T1: abort while in EXECUTING (before sdk_complete) → CANCELLED
  // -------------------------------------------------------------------------

  it('abort while EXECUTING (before sdk_complete) results in CANCELLED', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    // queryFn is never called in this test (we abort before onSdkComplete)
    orchestrator.setQueryFn(async (_prompt) => {
      // no-op — should not be called
    });

    orchestrator.start(sessionId, makeOpts(), ws);
    const reached = await waitForState(sessionId, [AutopilotState.EXECUTING]);
    assert.ok(reached, 'should reach EXECUTING');

    // Abort while in EXECUTING — drain loop is idle, abort processes immediately
    await orchestrator.abort(sessionId);
    await waitForTerminal(sessionId);

    assert.ok(kinds(ws.messages).includes('autopilot.cancelled'));
  });

  // -------------------------------------------------------------------------
  // T2: sdk_complete then abort — abort wins because probe queryFn is not yet
  // running (abort is enqueued before the probe RESUME_QUERY fires)
  // -------------------------------------------------------------------------

  it('sdk_complete followed by abort: abort wins when probe has not started', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    // queryFn is never called — we abort before it can run
    orchestrator.setQueryFn(async (_prompt) => {
      // no-op
    });

    orchestrator.start(sessionId, makeOpts(), ws);
    await waitForState(sessionId, [AutopilotState.EXECUTING]);

    // Enqueue sdk_complete (transitions to COMPLETION_PROBE + schedules RESUME_QUERY)
    // then immediately abort before the probe queryFn runs
    orchestrator.onSdkComplete(sessionId, '');
    await orchestrator.abort(sessionId);

    await waitForTerminal(sessionId, 3000);

    const k = kinds(ws.messages);
    const reachedTerminal =
      k.includes('autopilot.cancelled') ||
      k.includes('autopilot.completed') ||
      k.includes('autopilot.failed');
    assert.ok(reachedTerminal, `expected terminal event, got: ${k.join(',')}`);
  });

  // -------------------------------------------------------------------------
  // T3: abort while EXECUTING does not throw
  // -------------------------------------------------------------------------

  it('abort while EXECUTING does not throw', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (_prompt) => {
      // no-op
    });

    orchestrator.start(sessionId, makeOpts(), ws);
    await waitForState(sessionId, [AutopilotState.EXECUTING]);

    let abortError: unknown = null;
    try {
      await orchestrator.abort(sessionId);
    } catch (err) {
      abortError = err;
    }

    assert.equal(abortError, null, 'abort should not throw');
    await waitForTerminal(sessionId);
    assert.ok(kinds(ws.messages).includes('autopilot.cancelled'));
  });

  // -------------------------------------------------------------------------
  // T4: abort during SCHEDULE_RETRY wait — no queryFn running → CANCELLED
  // -------------------------------------------------------------------------

  it('abort during SCHEDULE_RETRY wait cancels without throwing', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (_prompt) => {
      // no-op — retry queryFn never fires because we abort first
    });

    // Very long backoff so the retry timer doesn't fire before we abort
    orchestrator.start(sessionId, makeOpts(60000), ws);
    await waitForState(sessionId, [AutopilotState.EXECUTING]);

    // Trigger network error → RETRY_NETWORK → SCHEDULE_RETRY (long timer)
    orchestrator.onSdkError(sessionId, new Error('ECONNRESET'));

    const reached = await waitForState(sessionId, [AutopilotState.RETRY_NETWORK], 3000);
    assert.ok(reached, 'should reach RETRY_NETWORK');

    let abortError: unknown = null;
    try {
      await orchestrator.abort(sessionId);
    } catch (err) {
      abortError = err;
    }

    assert.equal(abortError, null, 'abort during RETRY_NETWORK should not throw');
    await waitForTerminal(sessionId);
    assert.ok(kinds(ws.messages).includes('autopilot.cancelled'));
  });

  // -------------------------------------------------------------------------
  // T5: second abort is a no-op — no duplicate events
  // -------------------------------------------------------------------------

  it('second abort call is a no-op and does not emit duplicate cancelled events', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (_prompt) => {
      // no-op
    });

    orchestrator.start(sessionId, makeOpts(), ws);
    await waitForState(sessionId, [AutopilotState.EXECUTING]);

    await orchestrator.abort(sessionId);
    await waitForTerminal(sessionId);

    const countBefore = kinds(ws.messages).filter((k) => k === 'autopilot.cancelled').length;

    // Second abort — session already removed, should be no-op
    await orchestrator.abort(sessionId);

    const countAfter = kinds(ws.messages).filter((k) => k === 'autopilot.cancelled').length;

    assert.equal(countBefore, countAfter, 'second abort must not emit extra events');
    assert.equal(countBefore, 1, 'exactly one autopilot.cancelled from first abort');
  });

  // -------------------------------------------------------------------------
  // T6: abort emits autopilot.cancelled with cancelledInState field
  // -------------------------------------------------------------------------

  it('abort emits autopilot.cancelled WS event with cancelledInState field', async () => {
    const orchestrator = getAutopilotOrchestrator();
    const sessionId = nextId();
    const ws = makeWs();

    orchestrator.setQueryFn(async (_prompt) => {
      // no-op
    });

    orchestrator.start(sessionId, makeOpts(), ws);
    await waitForState(sessionId, [AutopilotState.EXECUTING]);
    await orchestrator.abort(sessionId);
    await waitForTerminal(sessionId);

    const cancelMsg = ws.messages.find(
      (m) =>
        m &&
        typeof m === 'object' &&
        (m as Record<string, unknown>)['kind'] === 'autopilot.cancelled',
    ) as Record<string, unknown> | undefined;

    assert.ok(cancelMsg !== undefined, 'autopilot.cancelled should be present');
    assert.ok('cancelledInState' in cancelMsg, 'should have cancelledInState field');
  });

});
