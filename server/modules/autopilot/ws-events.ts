// Autopilot WS event factories — all autopilot-specific WebSocket events are
// constructed here so callers never hand-roll the payload shape.
//
// These events use the `autopilot.*` kind namespace and are sent via
// WebSocketWriter.send() directly (not through createNormalizedMessage) because
// they carry autopilot-specific fields and do not require the LLMProvider field
// that NormalizedMessage mandates.

import { randomUUID } from 'node:crypto';
import type { AutopilotState, AutopilotCounters, ReviewFinding } from './types.js';

// ---------------------------------------------------------------------------
// Kind constants
// ---------------------------------------------------------------------------

export const AUTOPILOT_EVENT_KINDS = {
  STATE_CHANGED: 'autopilot.state_changed',
  ITERATION: 'autopilot.iteration',
  LIMIT_REACHED: 'autopilot.limit_reached',
  COMPLETION_PROBE_RESULT: 'autopilot.completion_probe_result',
  COMPLETED: 'autopilot.completed',
  FAILED: 'autopilot.failed',
  CANCELLED: 'autopilot.cancelled',
  STATUS_SNAPSHOT: 'autopilot.status_snapshot',
} as const;

export type AutopilotEventKind = typeof AUTOPILOT_EVENT_KINDS[keyof typeof AUTOPILOT_EVENT_KINDS];

// ---------------------------------------------------------------------------
// Shared envelope builder
// ---------------------------------------------------------------------------

function makeEnvelope(kind: AutopilotEventKind, sessionId: string, extra: Record<string, unknown>): AutopilotWsEvent {
  return {
    kind,
    id: `${kind}_${randomUUID()}`,
    sessionId,
    timestamp: Date.now(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Base event type (all autopilot WS events share this shape)
// ---------------------------------------------------------------------------

export interface AutopilotWsEvent {
  kind: AutopilotEventKind;
  id: string;
  sessionId: string;
  timestamp: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface PendingPermission {
  tool: string;
  requestedAt: number;
}

export interface StateChangedPayload {
  sessionId: string;
  from: AutopilotState;
  to: AutopilotState;
  reason?: string;
  pendingPermission?: PendingPermission;
}

export interface IterationPayload {
  sessionId: string;
  iterationType: 'continue' | 'reviewFix' | 'networkRetry';
  count: number;
  max: number;
}

export interface LimitReachedPayload {
  sessionId: string;
  limitType: 'continue' | 'reviewFix' | 'networkRetry' | 'token';
  count: number;
  max: number;
}

export interface CompletionProbeResultPayload {
  sessionId: string;
  verdict: 'COMPLETED' | 'NOT_COMPLETED' | 'UNPARSED';
  rawSnippet?: string;
}

export interface CompletedPayload {
  sessionId: string;
  summary: {
    iterations: number;
    reviewRounds: number;
    commitHash?: string;
  };
}

export interface FailedPayload {
  sessionId: string;
  error: string;
  lastState: AutopilotState;
}

export interface CancelledPayload {
  sessionId: string;
  cancelledInState: AutopilotState;
}

export interface StatusSnapshotPayload {
  sessionId: string;
  state: AutopilotState;
  counters: AutopilotCounters;
  lastEvent?: string;
  pendingPermission?: PendingPermission;
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function createStateChangedEvent(p: StateChangedPayload): AutopilotWsEvent {
  return makeEnvelope(AUTOPILOT_EVENT_KINDS.STATE_CHANGED, p.sessionId, {
    from: p.from,
    to: p.to,
    reason: p.reason,
    pendingPermission: p.pendingPermission,
  });
}

export function createIterationEvent(p: IterationPayload): AutopilotWsEvent {
  return makeEnvelope(AUTOPILOT_EVENT_KINDS.ITERATION, p.sessionId, {
    iterationType: p.iterationType,
    count: p.count,
    max: p.max,
  });
}

export function createLimitReachedEvent(p: LimitReachedPayload): AutopilotWsEvent {
  return makeEnvelope(AUTOPILOT_EVENT_KINDS.LIMIT_REACHED, p.sessionId, {
    limitType: p.limitType,
    count: p.count,
    max: p.max,
  });
}

export function createCompletionProbeResultEvent(p: CompletionProbeResultPayload): AutopilotWsEvent {
  return makeEnvelope(AUTOPILOT_EVENT_KINDS.COMPLETION_PROBE_RESULT, p.sessionId, {
    verdict: p.verdict,
    rawSnippet: p.rawSnippet,
  });
}

export function createCompletedEvent(p: CompletedPayload): AutopilotWsEvent {
  return makeEnvelope(AUTOPILOT_EVENT_KINDS.COMPLETED, p.sessionId, {
    summary: p.summary,
  });
}

export function createFailedEvent(p: FailedPayload): AutopilotWsEvent {
  return makeEnvelope(AUTOPILOT_EVENT_KINDS.FAILED, p.sessionId, {
    error: p.error,
    lastState: p.lastState,
  });
}

export function createCancelledEvent(p: CancelledPayload): AutopilotWsEvent {
  return makeEnvelope(AUTOPILOT_EVENT_KINDS.CANCELLED, p.sessionId, {
    cancelledInState: p.cancelledInState,
  });
}

export function createStatusSnapshotEvent(p: StatusSnapshotPayload): AutopilotWsEvent {
  return makeEnvelope(AUTOPILOT_EVENT_KINDS.STATUS_SNAPSHOT, p.sessionId, {
    state: p.state,
    counters: p.counters,
    lastEvent: p.lastEvent,
    pendingPermission: p.pendingPermission,
  });
}
