import {
  AutopilotState,
  type AutopilotEvent,
  type AutopilotSessionContext,
  type AutopilotSideEffect,
  type ReducerResult,
  type ReviewFinding,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateChanged(
  from: AutopilotState,
  to: AutopilotState,
  reason: string,
): AutopilotSideEffect {
  return {
    type: 'EMIT_WS',
    payload: { kind: 'autopilot.state_changed', from, to, reason },
  };
}

function sortedFindingIds(findings: ReviewFinding[]): string {
  return JSON.stringify([...findings].map((f) => f.id).sort());
}

function findingsUnchanged(
  prev: ReviewFinding[] | null,
  next: ReviewFinding[],
): boolean {
  if (!prev) {
    return false;
  }
  return sortedFindingIds(prev) === sortedFindingIds(next);
}

// Exponential backoff: base * 2^(retryCount-1), capped at 60s.
function backoffMs(base: number, retryCount: number): number {
  return Math.min(base * Math.pow(2, retryCount - 1), 60_000);
}

function clone(ctx: AutopilotSessionContext): AutopilotSessionContext {
  return {
    ...ctx,
    counters: { ...ctx.counters },
    toggles: { ...ctx.toggles },
    limits: { ...ctx.limits },
    lastReviewFindings: ctx.lastReviewFindings ? [...ctx.lastReviewFindings] : null,
  };
}

// ---------------------------------------------------------------------------
// Abort — handled from any state
// ---------------------------------------------------------------------------

function handleAbort(ctx: AutopilotSessionContext): ReducerResult {
  const next = clone(ctx);
  next.state = AutopilotState.CANCELLED;
  next.cancelled = true;
  return {
    newContext: next,
    sideEffects: [
      stateChanged(ctx.state, AutopilotState.CANCELLED, 'abort'),
      { type: 'EMIT_WS', payload: { kind: 'autopilot.cancelled', cancelledInState: ctx.state } },
      { type: 'CLEANUP', payload: { reason: 'abort' } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main reducer — 19 transitions per plan
// ---------------------------------------------------------------------------

export function autopilotReducer(
  ctx: AutopilotSessionContext,
  event: AutopilotEvent,
): ReducerResult {
  // Abort is universal.
  if (event.type === 'abort') {
    return handleAbort(ctx);
  }

  const effects: AutopilotSideEffect[] = [];
  const next = clone(ctx);

  switch (ctx.state) {
    // -----------------------------------------------------------------------
    case AutopilotState.IDLE: {
      if (event.type === 'start') {
        next.state = AutopilotState.EXECUTING;
        next.counters = { continue: 0, reviewFix: 0, networkRetry: 0 };
        effects.push(stateChanged(ctx.state, next.state, 'start'));
        break;
      }
      break;
    }

    // -----------------------------------------------------------------------
    case AutopilotState.EXECUTING: {
      if (event.type === 'sdk_complete') {
        next.state = AutopilotState.COMPLETION_PROBE;
        effects.push(stateChanged(ctx.state, next.state, 'sdk_complete'));
        effects.push({
          type: 'RESUME_QUERY',
          payload: { prompt: '', purpose: 'probe' },
        });
        break;
      }
      if (event.type === 'sdk_error') {
        const { kind } = event.payload;
        if (kind === 'network' || kind === 'rate_limit') {
          next.counters.networkRetry += 1;
          if (next.counters.networkRetry > ctx.limits.maxNetworkRetry) {
            // Exceeded — emit limit_reached; orchestrator will re-dispatch that event.
            next.counters.networkRetry = ctx.counters.networkRetry; // revert increment
            effects.push({
              type: 'EMIT_WS',
              payload: {
                kind: 'autopilot.limit_reached',
                limitType: 'networkRetry',
                count: ctx.counters.networkRetry,
                max: ctx.limits.maxNetworkRetry,
              },
            });
            // Transition to FAILED via limit_reached side-channel.
            next.state = AutopilotState.FAILED;
            effects.push(stateChanged(ctx.state, next.state, 'network_retry_limit'));
            effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.failed', lastState: ctx.state } });
            effects.push({ type: 'CLEANUP', payload: { reason: 'network_retry_limit' } });
          } else {
            next.state = AutopilotState.RETRY_NETWORK;
            const delay = backoffMs(ctx.limits.backoffBaseMs, next.counters.networkRetry);
            effects.push(stateChanged(ctx.state, next.state, `sdk_error(${kind})`));
            effects.push({ type: 'SCHEDULE_RETRY', payload: { delayMs: delay } });
          }
        } else {
          // business error
          next.state = AutopilotState.FAILED;
          effects.push(stateChanged(ctx.state, next.state, 'sdk_error(business)'));
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.failed', lastState: ctx.state, error: event.payload.error } });
          effects.push({ type: 'CLEANUP', payload: { reason: 'business_error' } });
        }
        break;
      }
      if (event.type === 'limit_reached') {
        next.state = AutopilotState.FAILED;
        effects.push(stateChanged(ctx.state, next.state, `limit_reached(${event.payload.limitType})`));
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.failed', lastState: ctx.state } });
        effects.push({ type: 'CLEANUP', payload: { reason: `limit_reached(${event.payload.limitType})` } });
        break;
      }
      break;
    }

    // -----------------------------------------------------------------------
    case AutopilotState.RETRY_NETWORK: {
      if (event.type === 'retry_ready') {
        next.state = AutopilotState.EXECUTING;
        effects.push(stateChanged(ctx.state, next.state, 'retry_ready'));
        effects.push({ type: 'RESUME_QUERY', payload: { prompt: '继续', purpose: 'continue' } });
        break;
      }
      if (event.type === 'limit_reached') {
        next.state = AutopilotState.FAILED;
        effects.push(stateChanged(ctx.state, next.state, 'network_retry_limit'));
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.limit_reached', limitType: event.payload.limitType } });
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.failed', lastState: ctx.state } });
        effects.push({ type: 'CLEANUP', payload: { reason: 'network_retry_limit' } });
        break;
      }
      break;
    }

    // -----------------------------------------------------------------------
    case AutopilotState.COMPLETION_PROBE: {
      // probe_unparsed treated as probe_not_completed (safe continue).
      if (event.type === 'probe_not_completed' || event.type === 'probe_unparsed') {
        next.counters.continue += 1;
        if (next.counters.continue > ctx.limits.maxContinue) {
          next.counters.continue = ctx.counters.continue;
          next.state = AutopilotState.DONE;
          effects.push(stateChanged(ctx.state, next.state, 'continue_limit_reached'));
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.limit_reached', limitType: 'continue', count: ctx.counters.continue, max: ctx.limits.maxContinue } });
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.completed', summary: { iterations: ctx.counters.continue } } });
          effects.push({ type: 'CLEANUP', payload: { reason: 'continue_limit_reached' } });
        } else {
          next.state = AutopilotState.EXECUTING;
          effects.push(stateChanged(ctx.state, next.state, event.type));
          effects.push({ type: 'RESUME_QUERY', payload: { prompt: '继续', purpose: 'continue' } });
        }
        break;
      }
      if (event.type === 'probe_completed') {
        // Route based on toggles.
        if (ctx.toggles.reviewFix) {
          next.state = AutopilotState.REVIEWING;
          effects.push(stateChanged(ctx.state, next.state, 'probe_completed'));
          effects.push({ type: 'RESUME_QUERY', payload: { prompt: '', purpose: 'review' } });
        } else if (ctx.toggles.commit) {
          next.state = AutopilotState.COMMITTING;
          effects.push(stateChanged(ctx.state, next.state, 'probe_completed'));
          effects.push({ type: 'GIT_COMMIT', payload: {} });
        } else {
          next.state = AutopilotState.DONE;
          effects.push(stateChanged(ctx.state, next.state, 'probe_completed'));
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.completed', summary: { iterations: ctx.counters.continue } } });
          effects.push({ type: 'CLEANUP', payload: { reason: 'done' } });
        }
        break;
      }
      if (event.type === 'limit_reached') {
        next.state = AutopilotState.DONE;
        effects.push(stateChanged(ctx.state, next.state, `limit_reached(${event.payload.limitType})`));
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.limit_reached', limitType: event.payload.limitType } });
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.completed', summary: { iterations: ctx.counters.continue } } });
        effects.push({ type: 'CLEANUP', payload: { reason: `limit_reached(${event.payload.limitType})` } });
        break;
      }
      break;
    }

    // -----------------------------------------------------------------------
    case AutopilotState.REVIEWING: {
      if (event.type === 'review_pass') {
        if (ctx.toggles.commit) {
          next.state = AutopilotState.COMMITTING;
          effects.push(stateChanged(ctx.state, next.state, 'review_pass'));
          effects.push({ type: 'GIT_COMMIT', payload: {} });
        } else {
          next.state = AutopilotState.DONE;
          effects.push(stateChanged(ctx.state, next.state, 'review_pass'));
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.completed', summary: { iterations: ctx.counters.continue, reviewRounds: ctx.counters.reviewFix } } });
          effects.push({ type: 'CLEANUP', payload: { reason: 'done' } });
        }
        break;
      }
      if (event.type === 'review_fail') {
        const { findings } = event.payload;
        // If findings are identical to last round → force exit loop.
        if (findingsUnchanged(ctx.lastReviewFindings, findings)) {
          next.state = AutopilotState.DONE;
          next.lastReviewFindings = findings;
          effects.push(stateChanged(ctx.state, next.state, 'review_limit_reached(same_findings)'));
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.limit_reached', limitType: 'reviewFix' } });
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.completed', summary: { iterations: ctx.counters.continue, reviewRounds: ctx.counters.reviewFix, unresolvedFindings: findings } } });
          if (ctx.toggles.commit) {
            effects.push({ type: 'GIT_COMMIT', payload: { unresolved: findings } });
          } else {
            effects.push({ type: 'CLEANUP', payload: { reason: 'review_limit_same_findings' } });
          }
          break;
        }
        next.counters.reviewFix += 1;
        next.lastReviewFindings = findings;
        if (next.counters.reviewFix > ctx.limits.maxReviewFix) {
          next.counters.reviewFix = ctx.counters.reviewFix;
          next.state = AutopilotState.DONE;
          effects.push(stateChanged(ctx.state, next.state, 'review_limit_reached'));
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.limit_reached', limitType: 'reviewFix', count: ctx.counters.reviewFix, max: ctx.limits.maxReviewFix } });
          effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.completed', summary: { iterations: ctx.counters.continue, reviewRounds: ctx.counters.reviewFix, unresolvedFindings: findings } } });
          if (ctx.toggles.commit) {
            effects.push({ type: 'GIT_COMMIT', payload: { unresolved: findings } });
          } else {
            effects.push({ type: 'CLEANUP', payload: { reason: 'review_limit_reached' } });
          }
        } else {
          next.state = AutopilotState.FIXING;
          effects.push(stateChanged(ctx.state, next.state, 'review_fail'));
          effects.push({ type: 'RESUME_QUERY', payload: { prompt: '', purpose: 'fix' } });
        }
        break;
      }
      if (event.type === 'limit_reached') {
        next.state = AutopilotState.DONE;
        effects.push(stateChanged(ctx.state, next.state, `limit_reached(${event.payload.limitType})`));
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.limit_reached', limitType: event.payload.limitType } });
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.completed', summary: { iterations: ctx.counters.continue, reviewRounds: ctx.counters.reviewFix } } });
        effects.push({ type: 'CLEANUP', payload: { reason: `limit_reached(${event.payload.limitType})` } });
        break;
      }
      break;
    }

    // -----------------------------------------------------------------------
    case AutopilotState.FIXING: {
      if (event.type === 'fix_complete') {
        next.state = AutopilotState.REVIEWING;
        effects.push(stateChanged(ctx.state, next.state, 'fix_complete'));
        effects.push({ type: 'RESUME_QUERY', payload: { prompt: '', purpose: 'review' } });
        break;
      }
      break;
    }

    // -----------------------------------------------------------------------
    case AutopilotState.COMMITTING: {
      if (event.type === 'commit_success') {
        next.state = AutopilotState.DONE;
        effects.push(stateChanged(ctx.state, next.state, 'commit_success'));
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.completed', summary: { iterations: ctx.counters.continue, reviewRounds: ctx.counters.reviewFix, commitHash: event.payload.hash } } });
        effects.push({ type: 'CLEANUP', payload: { reason: 'done' } });
        break;
      }
      if (event.type === 'commit_error') {
        next.state = AutopilotState.FAILED;
        effects.push(stateChanged(ctx.state, next.state, 'commit_error'));
        effects.push({ type: 'EMIT_WS', payload: { kind: 'autopilot.failed', lastState: ctx.state, error: event.payload.error } });
        effects.push({ type: 'CLEANUP', payload: { reason: 'commit_error' } });
        break;
      }
      break;
    }

    // Terminal states — no further transitions (except abort handled above).
    case AutopilotState.DONE:
    case AutopilotState.FAILED:
    case AutopilotState.CANCELLED:
    case AutopilotState.WAITING_PERMISSION:
      break;

    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = ctx.state;
      void _exhaustive;
      break;
    }
  }

  return { newContext: next, sideEffects: effects };
}
