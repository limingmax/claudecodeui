import { useCallback, useState } from 'react';

// Inline type definitions — do not import from server modules
export type AutopilotPhase =
  | 'IDLE'
  | 'EXECUTING'
  | 'COMPLETION_PROBE'
  | 'REVIEWING'
  | 'FIXING'
  | 'COMMITTING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED';

export interface AutopilotCounters {
  continue: number;
  reviewFix: number;
  networkRetry: number;
}

export interface AutopilotLimits {
  maxContinue: number;
  maxReviewFix: number;
  maxNetworkRetry: number;
}

export interface AutopilotToggles {
  execution: boolean;
  reviewFix: boolean;
  commit: boolean;
}

export interface AutopilotPendingPermission {
  tool: string;
  requestedAt: number;
}

export interface AutopilotSnapshot {
  state: AutopilotPhase;
  counters: AutopilotCounters;
  limits: AutopilotLimits;
  toggles: AutopilotToggles;
  pendingPermission?: AutopilotPendingPermission;
}

// WS message shape from server autopilot events
interface AutopilotWsMessage {
  kind?: string;
  state?: AutopilotPhase;
  /** state_changed event: target state (server emits `to`, not `state`) */
  to?: AutopilotPhase;
  pendingPermission?: AutopilotPendingPermission;
  counters?: Partial<AutopilotCounters>;
  // autopilot.status_snapshot carries full snapshot
  snapshot?: Partial<AutopilotSnapshot>;
  [key: string]: unknown;
}

const DEFAULT_LIMITS: AutopilotLimits = {
  maxContinue: 5,
  maxReviewFix: 5,
  maxNetworkRetry: 3,
};

const DEFAULT_TOGGLES: AutopilotToggles = {
  execution: false,
  reviewFix: false,
  commit: false,
};

const DEFAULT_COUNTERS: AutopilotCounters = {
  continue: 0,
  reviewFix: 0,
  networkRetry: 0,
};

export interface UseAutopilotStateReturn {
  snapshot: AutopilotSnapshot;
  setToggles: (next: AutopilotToggles) => void;
  setLimits: (next: AutopilotLimits) => void;
  handleAutopilotEvent: (msg: AutopilotWsMessage) => void;
  onLimitReached?: (msg: AutopilotWsMessage) => void;
}

export function useAutopilotState(
  onLimitReached?: (msg: AutopilotWsMessage) => void,
): UseAutopilotStateReturn {
  const [state, setState] = useState<AutopilotPhase>('IDLE');
  const [counters, setCounters] = useState<AutopilotCounters>(DEFAULT_COUNTERS);
  const [limits, setLimits] = useState<AutopilotLimits>(DEFAULT_LIMITS);
  const [toggles, setToggles] = useState<AutopilotToggles>(DEFAULT_TOGGLES);
  const [pendingPermission, setPendingPermission] = useState<
    AutopilotPendingPermission | undefined
  >(undefined);

  const handleAutopilotEvent = useCallback(
    (msg: AutopilotWsMessage) => {
      if (!msg.kind) return;
      switch (msg.kind) {
        case 'autopilot.state_changed': {
          // Server emits { kind, from, to, reason } — read `to` not `state`.
          if (msg.to) {
            setState(msg.to);
          }
          // Extract pendingPermission if present in payload
          setPendingPermission(msg.pendingPermission ?? undefined);
          break;
        }

        case 'autopilot.iteration': {
          if (msg.counters) {
            setCounters((prev) => ({
              continue: msg.counters?.continue ?? prev.continue,
              reviewFix: msg.counters?.reviewFix ?? prev.reviewFix,
              networkRetry: msg.counters?.networkRetry ?? prev.networkRetry,
            }));
          }
          break;
        }

        case 'autopilot.completion_probe_result': {
          // No state update — informational only; caller may log if needed
          break;
        }

        case 'autopilot.limit_reached': {
          onLimitReached?.(msg);
          break;
        }

        case 'autopilot.completed':
        case 'autopilot.failed':
        case 'autopilot.cancelled': {
          setState('IDLE');
          setCounters(DEFAULT_COUNTERS);
          setPendingPermission(undefined);
          break;
        }

        case 'autopilot.status_snapshot': {
          // Hydrate full state from server snapshot
          const snap = msg.snapshot ?? {};
          if (snap.state) setState(snap.state);
          if (snap.counters) {
            setCounters((prev) => ({ ...prev, ...snap.counters }));
          }
          if (snap.limits) {
            setLimits((prev) => ({ ...prev, ...snap.limits }));
          }
          if (snap.toggles) {
            setToggles((prev) => ({ ...prev, ...snap.toggles }));
          }
          setPendingPermission(snap.pendingPermission ?? undefined);
          break;
        }

        default:
          break;
      }
    },
    [onLimitReached],
  );

  const snapshot: AutopilotSnapshot = {
    state,
    counters,
    limits,
    toggles,
    pendingPermission,
  };

  return {
    snapshot,
    setToggles,
    setLimits,
    handleAutopilotEvent,
  };
}
