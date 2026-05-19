// Side-effect executor — consumes AutopilotSideEffect[] produced by the reducer.
// Stateless; all session state lives in the orchestrator handle.

import type { AutopilotSideEffect, AutopilotSessionContext } from '../types.js';
import type { WebSocketWriter } from '@/modules/websocket/index.js';
import {
  DEFAULT_PROBE_PROMPT,
  DEFAULT_REVIEW_PROMPT,
} from '../config.js';
import { buildReviewPrompt } from './review.service.js';
import type { ReviewFinding } from '../types.js';
import { commitWithAutopilot } from './commit.service.js';
import { getAutopilotOrchestrator } from './orchestrator.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryFn = (
  prompt: string,
  options: Record<string, unknown>,
  ws: WebSocketWriter,
) => Promise<void>;

export type EnqueueFn = (event: import('../types.js').AutopilotEvent) => void;

export interface SideEffectDeps {
  sessionId: string;
  ws: WebSocketWriter;
  cwd: string;
  enqueue: EnqueueFn;
  getQueryFn: () => QueryFn | null;
  /** Original cleanup hook registered when the session was created. */
  cleanup: (reason: string) => Promise<void>;
  /** Last reviewer findings — used to build fix prompts. */
  lastReviewFindings: ReviewFinding[] | null;
  /** Config overrides for prompts. */
  probePrompt?: string;
  reviewPrompt?: string;
  /** Timeout (ms) for tool approval prompts; 0 = auto-deny immediately. */
  toolApprovalTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildFixPrompt(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return '请修复上一轮 review 发现的所有问题。';
  }
  const list = findings
    .map((f) => `- [${f.severity}] ${f.message}${f.file ? ` (${f.file}${f.line != null ? `:${f.line}` : ''})` : ''}`)
    .join('\n');
  return `请修复以下 review findings：\n${list}`;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeSideEffects(
  effects: AutopilotSideEffect[],
  ctx: AutopilotSessionContext,
  deps: SideEffectDeps,
): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case 'EMIT_WS': {
        // Autopilot events use custom kinds not in MessageKind union.
        // Send the raw payload directly rather than through createNormalizedMessage.
        deps.ws.send({
          ...effect.payload,
          sessionId: deps.sessionId,
        });
        break;
      }

      case 'RESUME_QUERY': {
        const queryFn = deps.getQueryFn();
        if (!queryFn) {
          // queryFn not yet injected — treat as transient error.
          deps.enqueue({ type: 'sdk_error', payload: { kind: 'business', error: new Error('queryFn not injected') } });
          break;
        }

        let prompt: string;
        const { purpose } = effect.payload;

        if (purpose === 'probe') {
          prompt = deps.probePrompt ?? DEFAULT_PROBE_PROMPT;
        } else if (purpose === 'continue') {
          prompt = '继续';
        } else if (purpose === 'review') {
          prompt = buildReviewPrompt(
            { reviewPrompt: deps.reviewPrompt ?? DEFAULT_REVIEW_PROMPT },
          );
        } else {
          // purpose === 'fix'
          prompt = buildFixPrompt(deps.lastReviewFindings ?? []);
        }

        // Wrap the real ws with a capturing decorator so we can collect the
        // assistant text from this non-autopilot query turn and feed it back
        // to the orchestrator once the query completes.
        // The decorator dual-writes: all messages still reach the real ws
        // (so the user sees the response), and text blocks are buffered locally.
        const capturedChunks: string[] = [];
        const capturingWs: WebSocketWriter = {
          ...deps.ws,
          send(data: unknown): void {
            // Forward to real ws first.
            deps.ws.send(data);
            // Capture assistant text from normalized messages.
            if (data && typeof data === 'object') {
              const msg = data as Record<string, unknown>;
              if (msg.kind === 'text' && typeof msg.content === 'string') {
                capturedChunks.push(msg.content);
              }
            }
          },
        } as WebSocketWriter;

        // Set purpose on orchestrator before the query so onSdkComplete routes correctly.
        getAutopilotOrchestrator().setCurrentPurpose(deps.sessionId, purpose);

        try {
          await queryFn(
            prompt,
            {
              sessionId: deps.sessionId,
              cwd: deps.cwd,
              // Explicitly clear autopilot to prevent recursive triggering.
              autopilot: undefined,
              // Pass through tool approval timeout from autopilot config.
              ...(deps.toolApprovalTimeoutMs !== undefined && {
                toolApprovalTimeoutMs: deps.toolApprovalTimeoutMs,
              }),
            },
            capturingWs,
          );
          // Query completed — notify orchestrator with captured assistant text.
          const assistantText = capturedChunks.join('');
          getAutopilotOrchestrator().onSdkComplete(deps.sessionId, assistantText);
        } catch (err) {
          deps.enqueue({ type: 'sdk_error', payload: { kind: 'network', error: err } });
        }
        break;
      }

      case 'GIT_COMMIT': {
        try {
          const result = await commitWithAutopilot({
            cwd: deps.cwd,
            ws: deps.ws,
            sessionId: deps.sessionId,
            unresolvedFindings: effect.payload.unresolved,
          });

          if (result.skipped) {
            // Nothing to commit — treat as success with no hash.
            deps.enqueue({ type: 'commit_success', payload: { hash: '' } });
          } else {
            deps.enqueue({ type: 'commit_success', payload: { hash: result.hash ?? '' } });
          }
        } catch (err) {
          deps.enqueue({ type: 'commit_error', payload: { error: err } });
        }
        break;
      }

      case 'SCHEDULE_RETRY': {
        const { delayMs } = effect.payload;
        setTimeout(() => {
          deps.enqueue({ type: 'retry_ready' });
        }, delayMs);
        break;
      }

      case 'CLEANUP': {
        try {
          await deps.cleanup(effect.payload.reason);
        } catch (err) {
          // Cleanup errors are non-fatal; log and continue.
          console.error('[autopilot] cleanup error:', err);
        }
        break;
      }

      default: {
        // Exhaustiveness guard — unknown effect types are silently ignored.
        const _exhaustive: never = effect;
        void _exhaustive;
        break;
      }
    }
  }
}
