import { autopilotReducer } from './reducer.js';
import type {
  AutopilotEvent,
  AutopilotSessionContext,
  AutopilotSideEffect,
} from './types.js';

type ContextGetter = () => AutopilotSessionContext;
type ContextSetter = (ctx: AutopilotSessionContext) => void;
type SideEffectExecutor = (effects: AutopilotSideEffect[], ctx: AutopilotSessionContext) => Promise<void>;

export class AutopilotEventQueue {
  private queue: AutopilotEvent[] = [];
  private _processing = false;
  private _drainPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly getContext: ContextGetter,
    private readonly setContext: ContextSetter,
    private readonly executor: SideEffectExecutor,
  ) {}

  get processing(): boolean {
    return this._processing;
  }

  /** Resolves when the current drain cycle (and all its side effects) finishes. */
  get drainPromise(): Promise<void> {
    return this._drainPromise;
  }

  enqueue(event: AutopilotEvent): void {
    this.queue.push(event);
    if (!this._processing) {
      // Set _processing synchronously before the async drain body runs.
      // This prevents a second concurrent drain from starting if enqueue()
      // is called again before the first drain's async body begins executing
      // (e.g. abort() called synchronously after onSdkComplete()).
      this._processing = true;
      // Track the drain promise so callers can await full side-effect completion.
      this._drainPromise = this.drain();
    }
  }

  private async drain(): Promise<void> {
    // _processing is already set to true by enqueue() before this body runs.
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();

        // When cancelled, only process the abort event (to emit CLEANUP/cancelled WS).
        // All other events are discarded — but a pending abort must not be lost.
        if (this.getContext().cancelled && event?.type !== 'abort') {
          // Keep only a pending abort event so the protocol can still complete.
          // Clearing the whole queue would discard an abort that was enqueued
          // before this drain iteration started (e.g. abort() called while drain
          // was suspended at an await mid-way through an earlier event's effects).
          this.queue = this.queue.filter(e => e.type === 'abort');
          if (this.queue.length === 0) break;
          continue; // let the while loop pick up the pending abort
        }
        if (!event) {
          break;
        }

        let result;
        try {
          result = autopilotReducer(this.getContext(), event);
        } catch (err) {
          // Reducer threw — treat as business error and re-enqueue.
          this.enqueue({ type: 'sdk_error', payload: { kind: 'business', error: err } });
          continue;
        }

        this.setContext(result.newContext);

        // For abort events, always execute all side effects (emit cancelled + cleanup).
        const isAbort = event.type === 'abort';
        for (const effect of result.sideEffects) {
          if (!isAbort && this.getContext().cancelled) {
            break;
          }
          try {
            await this.executor([effect], this.getContext());
          } catch (err) {
            // Side-effect failure — inject error event at queue tail.
            this.enqueue({ type: 'sdk_error', payload: { kind: 'business', error: err } });
          }
        }
      }
    } finally {
      this._processing = false;
    }
  }
}
