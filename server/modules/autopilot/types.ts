// Autopilot state machine — all shared types.
// No runtime dependencies; safe to import from any layer.

export enum AutopilotState {
  IDLE = 'IDLE',
  EXECUTING = 'EXECUTING',
  // WAITING_PERMISSION is kept for UI labelling only; not a node in the transition table.
  WAITING_PERMISSION = 'WAITING_PERMISSION',
  RETRY_NETWORK = 'RETRY_NETWORK',
  COMPLETION_PROBE = 'COMPLETION_PROBE',
  REVIEWING = 'REVIEWING',
  FIXING = 'FIXING',
  COMMITTING = 'COMMITTING',
  DONE = 'DONE',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface AutopilotToggles {
  execution: boolean;
  reviewFix: boolean;
  commit: boolean;
}

export interface AutopilotLimits {
  maxContinue: number;
  maxReviewFix: number;
  maxNetworkRetry: number;
  backoffBaseMs: number;
  toolApprovalTimeoutMs: number;
  tokenBudgetExitThreshold: number;
}

export interface AutopilotConfig {
  toggles: AutopilotToggles;
  limits: AutopilotLimits;
  probePrompt: string;
  reviewPrompt: string;
  commitTrailers: boolean;
}

export interface AutopilotCounters {
  continue: number;
  reviewFix: number;
  networkRetry: number;
}

export type SdkErrorKind = 'network' | 'rate_limit' | 'business';

export interface ReviewFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  file?: string;
  line?: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AutopilotEvent =
  | { type: 'start' }
  | { type: 'sdk_complete' }
  | { type: 'sdk_error'; payload: { kind: SdkErrorKind; error: unknown } }
  | { type: 'retry_ready' }
  | { type: 'probe_completed' }
  | { type: 'probe_not_completed' }
  | { type: 'probe_unparsed' }
  | { type: 'review_pass' }
  | { type: 'review_fail'; payload: { findings: ReviewFinding[]; severity: 'high' | 'critical' | 'medium' | 'low' } }
  | { type: 'fix_complete' }
  | { type: 'commit_success'; payload: { hash: string } }
  | { type: 'commit_error'; payload: { error: unknown } }
  | { type: 'limit_reached'; payload: { limitType: 'continue' | 'reviewFix' | 'networkRetry' | 'token' } }
  | { type: 'abort' };

// ---------------------------------------------------------------------------
// Side effects (produced by reducer, executed by orchestrator)
// ---------------------------------------------------------------------------

export type AutopilotSideEffect =
  | { type: 'EMIT_WS'; payload: { kind: string; [key: string]: unknown } }
  | { type: 'RESUME_QUERY'; payload: { prompt: string; purpose: 'continue' | 'probe' | 'review' | 'fix' } }
  | { type: 'GIT_COMMIT'; payload: { unresolved?: ReviewFinding[] } }
  | { type: 'SCHEDULE_RETRY'; payload: { delayMs: number } }
  | { type: 'CLEANUP'; payload: { reason: string } };

// ---------------------------------------------------------------------------
// Session context (immutable input/output of reducer)
// ---------------------------------------------------------------------------

export interface AutopilotSessionContext {
  state: AutopilotState;
  counters: AutopilotCounters;
  toggles: AutopilotToggles;
  limits: AutopilotLimits;
  lastReviewFindings: ReviewFinding[] | null;
  cancelled: boolean;
}

export interface ReducerResult {
  newContext: AutopilotSessionContext;
  sideEffects: AutopilotSideEffect[];
}
