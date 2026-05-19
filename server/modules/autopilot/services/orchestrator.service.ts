// Autopilot orchestrator — singleton that manages all active autopilot sessions.
// Bridges the event queue / reducer / side-effect executor layers.

import { AutopilotEventQueue } from '../event-queue.js';
import { autopilotReducer } from '../reducer.js';
import {
  AutopilotState,
  type AutopilotEvent,
  type AutopilotSessionContext,
  type AutopilotSideEffect,
  type AutopilotToggles,
  type AutopilotLimits,
  type ReviewFinding,
} from '../types.js';
import { getDefaultLimits } from '../config.js';
import { autopilotHistoryDb } from '@/modules/database/index.js';
import type { WebSocketWriter } from '@/modules/websocket/index.js';
import { executeSideEffects, type QueryFn } from './side-effect-executor.js';
import { parseCompletionVerdict } from './completion-probe.service.js';
import { parseReviewResult } from './review.service.js';

// ---------------------------------------------------------------------------
// Pending intent — registered before sessionId is known
// ---------------------------------------------------------------------------

interface PendingIntent {
  opts: AutopilotStartOptions;
  ws: WebSocketWriter;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutopilotStartOptions {
  toggles: AutopilotToggles;
  limits?: Partial<AutopilotLimits>;
  cwd: string;
  probePrompt?: string;
  reviewPrompt?: string;
  /** Called when the session ends (removes session, cleans temp files, etc.). */
  cleanup: (reason: string) => Promise<void>;
}

interface AutopilotSessionHandle {
  context: AutopilotSessionContext;
  eventQueue: AutopilotEventQueue;
  ws: WebSocketWriter;
  sessionId: string;
  cwd: string;
  probePrompt?: string;
  reviewPrompt?: string;
  cleanup: (reason: string) => Promise<void>;
  /** Accumulated assistant text from the current SDK turn (for probe/review parsing). */
  currentTurnText: string;
  /** Purpose of the current SDK turn. */
  currentPurpose: 'execute' | 'probe' | 'review' | 'fix' | 'continue' | 'commit';
  /**
   * True while a SDK turn is in-flight (set by setCurrentPurpose, cleared by
   * onSdkComplete). Guards against double-dispatch when both the queryFn mock
   * and the side-effect-executor wrapper call onSdkComplete for the same turn.
   */
  turnPending: boolean;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

class AutopilotOrchestrator {
  private readonly sessions = new Map<string, AutopilotSessionHandle>();
  private _queryFn: QueryFn | null = null;
  /** Pending intents keyed by a temporary intent id, waiting for sessionId binding. */
  private readonly pendingIntents = new Map<string, PendingIntent>();
  /** Maps WebSocketWriter instance → intentId for O(1) lookup on bindIntent. */
  private readonly writerToIntent = new Map<WebSocketWriter, string>();

  // -------------------------------------------------------------------------
  // Query function injection (called once at server startup)
  // -------------------------------------------------------------------------

  setQueryFn(fn: QueryFn): void {
    this._queryFn = fn;
  }

  // -------------------------------------------------------------------------
  // Pending intent — deferred sessionId binding
  // -------------------------------------------------------------------------

  /**
   * Registers an autopilot intent before the SDK sessionId is known.
   * Returns an intentId that must be passed to bindIntent() once the sessionId
   * is available (i.e. when the SDK emits session_created).
   *
   * Call this from chat-websocket before invoking queryClaudeSDK.
   */
  registerIntent(ws: WebSocketWriter, opts: AutopilotStartOptions): string {
    const intentId = `intent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.pendingIntents.set(intentId, { opts, ws });
    this.writerToIntent.set(ws, intentId);
    return intentId;
  }

  /**
   * Binds a pending intent to a real sessionId and starts the orchestrator.
   * Called when the SDK emits session_created and the sessionId becomes known.
   *
   * If no pending intent exists for this writer, this is a no-op (non-autopilot session).
   */
  bindIntent(ws: WebSocketWriter, sessionId: string): void {
    const intentId = this.writerToIntent.get(ws);
    if (!intentId) {
      return;
    }

    const intent = this.pendingIntents.get(intentId);
    if (!intent) {
      this.writerToIntent.delete(ws);
      return;
    }

    // Clean up pending maps.
    this.pendingIntents.delete(intentId);
    this.writerToIntent.delete(ws);

    // Start the orchestrator session now that we have a real sessionId.
    this.start(sessionId, intent.opts, intent.ws);
  }

  /**
   * Cancels a pending intent without starting a session.
   * Call this if the SDK query fails before session_created is emitted.
   */
  cancelIntent(ws: WebSocketWriter): void {
    const intentId = this.writerToIntent.get(ws);
    if (intentId) {
      this.pendingIntents.delete(intentId);
      this.writerToIntent.delete(ws);
    }
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  start(sessionId: string, opts: AutopilotStartOptions, ws: WebSocketWriter): void {
    if (this.sessions.has(sessionId)) {
      return; // Already running — idempotent.
    }

    const limits: AutopilotLimits = { ...getDefaultLimits(), ...(opts.limits ?? {}) };

    const initialContext: AutopilotSessionContext = {
      state: AutopilotState.IDLE,
      counters: { continue: 0, reviewFix: 0, networkRetry: 0 },
      toggles: opts.toggles,
      limits,
      lastReviewFindings: null,
      cancelled: false,
    };

    const handle: AutopilotSessionHandle = {
      context: initialContext,
      ws,
      sessionId,
      cwd: opts.cwd,
      probePrompt: opts.probePrompt,
      reviewPrompt: opts.reviewPrompt,
      cleanup: opts.cleanup,
      currentTurnText: '',
      currentPurpose: 'execute',
      turnPending: true, // initial execute turn is pending from the start
      // eventQueue assigned below after handle is created
      eventQueue: null as unknown as AutopilotEventQueue,
    };

    const queue = new AutopilotEventQueue(
      () => handle.context,
      (ctx) => {
        const prev = handle.context;
        handle.context = ctx;
        // Persist every state transition to history DB.
        if (prev.state !== ctx.state) {
          try {
            autopilotHistoryDb.insert({
              sessionId,
              fromState: prev.state,
              toState: ctx.state,
              event: 'transition',
              counters: ctx.counters as unknown as Record<string, number>,
            });
          } catch (err) {
            console.error('[autopilot] history insert error:', err);
          }
        }
      },
      async (effects: AutopilotSideEffect[], ctx: AutopilotSessionContext) => {
        await executeSideEffects(effects, ctx, {
          sessionId,
          ws: handle.ws,
          cwd: handle.cwd,
          enqueue: (event) => handle.eventQueue.enqueue(event),
          getQueryFn: () => this._queryFn,
          cleanup: async (reason) => {
            await handle.cleanup(reason);
            this.sessions.delete(sessionId);
          },
          lastReviewFindings: handle.context.lastReviewFindings,
          probePrompt: handle.probePrompt,
          reviewPrompt: handle.reviewPrompt,
          toolApprovalTimeoutMs: handle.context.limits.toolApprovalTimeoutMs,
        });
      },
    );

    handle.eventQueue = queue;
    this.sessions.set(sessionId, handle);

    queue.enqueue({ type: 'start' });
  }

  // -------------------------------------------------------------------------
  // SDK callbacks (called by claude-sdk.js integration in Step 4)
  // -------------------------------------------------------------------------

  /**
   * Called when the SDK turn completes. Accumulates assistant text and
   * dispatches the appropriate probe/review/fix event.
   */
  onSdkComplete(sessionId: string, assistantText: string, tokenBudget?: { used: number; total: number }): void {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      return;
    }

    // Guard against double-dispatch: if the turn was already consumed (e.g. the
    // mock queryFn called onSdkComplete and the side-effect-executor wrapper also
    // calls it), silently ignore the second call.
    if (!handle.turnPending) {
      return;
    }
    handle.turnPending = false;

    // Token budget exit check.
    if (tokenBudget) {
      const { used, total } = tokenBudget;
      const remaining = total > 0 ? (total - used) / total : 1;
      if (remaining < handle.context.limits.tokenBudgetExitThreshold) {
        handle.eventQueue.enqueue({ type: 'limit_reached', payload: { limitType: 'token' } });
        return;
      }
    }

    const purpose = handle.currentPurpose;
    handle.currentTurnText = '';

    if (purpose === 'probe') {
      const verdict = parseCompletionVerdict(assistantText);
      if (verdict === 'COMPLETED') {
        handle.eventQueue.enqueue({ type: 'probe_completed' });
      } else if (verdict === 'NOT_COMPLETED') {
        handle.eventQueue.enqueue({ type: 'probe_not_completed' });
      } else {
        handle.eventQueue.enqueue({ type: 'probe_unparsed' });
      }
    } else if (purpose === 'review') {
      const result = parseReviewResult(assistantText);
      if (result.hasHighOrCritical) {
        handle.eventQueue.enqueue({
          type: 'review_fail',
          payload: { findings: result.findings, severity: 'high' },
        });
      } else {
        handle.eventQueue.enqueue({ type: 'review_pass' });
      }
    } else if (purpose === 'fix') {
      handle.eventQueue.enqueue({ type: 'fix_complete' });
    } else {
      // execute / continue — normal SDK completion.
      handle.eventQueue.enqueue({ type: 'sdk_complete' });
    }
  }

  onSdkError(sessionId: string, error: unknown): void {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      return;
    }

    const kind = classifyError(error);
    handle.eventQueue.enqueue({ type: 'sdk_error', payload: { kind, error } });
  }

  /** Updates the current turn purpose so onSdkComplete routes correctly.
   * Also re-arms turnPending so the guard in onSdkComplete accepts the
   * upcoming completion call for this new turn.
   */
  setCurrentPurpose(
    sessionId: string,
    purpose: AutopilotSessionHandle['currentPurpose'],
  ): void {
    const handle = this.sessions.get(sessionId);
    if (handle) {
      handle.currentPurpose = purpose;
      handle.turnPending = true;
    }
  }

  // -------------------------------------------------------------------------
  // Abort — three-step protocol per plan
  // -------------------------------------------------------------------------

  async abort(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      return;
    }

    // 1. Mark cancelled so the queue drains no further events.
    handle.context = { ...handle.context, cancelled: true };

    // 2. Enqueue abort so the reducer emits CLEANUP side effect.
    handle.eventQueue.enqueue({ type: 'abort' });

    // 3. Wait for the drain cycle to finish so all side effects (EMIT_WS
    //    autopilot.cancelled + CLEANUP) are fully executed before returning.
    //    Without this await, callers see the CANCELLED state immediately but
    //    the WS event and session cleanup have not yet run.
    await handle.eventQueue.drainPromise;

    // 4. Session removal happens inside the CLEANUP side effect handler.
  }

  // -------------------------------------------------------------------------
  // WS reconnect snapshot
  // -------------------------------------------------------------------------

  getSnapshot(sessionId: string): AutopilotSessionContext | null {
    return this.sessions.get(sessionId)?.context ?? null;
  }

  // -------------------------------------------------------------------------
  // WS handle update (reconnect)
  // -------------------------------------------------------------------------

  updateWebSocket(sessionId: string, ws: WebSocketWriter): void {
    const handle = this.sessions.get(sessionId);
    if (handle) {
      handle.ws = ws;
    }
  }
}

// ---------------------------------------------------------------------------
// Error classifier
// ---------------------------------------------------------------------------

function classifyError(error: unknown): 'network' | 'rate_limit' | 'business' {
  if (!error) {
    return 'business';
  }
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('429') ||
    msg.includes('too many requests')
  ) {
    return 'rate_limit';
  }

  if (
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('socket') ||
    msg.includes('fetch failed') ||
    msg.includes('connection')
  ) {
    return 'network';
  }

  return 'business';
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: AutopilotOrchestrator | null = null;

export function getAutopilotOrchestrator(): AutopilotOrchestrator {
  if (!_instance) {
    _instance = new AutopilotOrchestrator();
  }
  return _instance;
}

export type { AutopilotOrchestrator };
