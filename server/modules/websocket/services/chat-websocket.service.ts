import type { WebSocket } from 'ws';
import path from 'node:path';

import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';
import { getAutopilotOrchestrator } from '@/modules/autopilot/index.js';
import type { AutopilotStartOptions } from '@/modules/autopilot/index.js';
import type { AutopilotToggles, AutopilotLimits } from '@/modules/autopilot/index.js';

// ---------------------------------------------------------------------------
// cwd path validation for autopilot (security: prevent path traversal)
// ---------------------------------------------------------------------------

const ALLOWED_WORKSPACE_ROOT = path.resolve(
  process.env['WORKSPACE_ROOT'] || process.cwd(),
);

function validateCwd(raw: string): string {
  const resolved = path.resolve(raw);
  const rootWithSep = ALLOWED_WORKSPACE_ROOT + path.sep;
  if (resolved !== ALLOWED_WORKSPACE_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error(`cwd "${resolved}" is outside allowed workspace root "${ALLOWED_WORKSPACE_ROOT}"`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Autopilot options shape expected from the WS client
// ---------------------------------------------------------------------------

interface AutopilotWsOptions {
  execution?: boolean;
  reviewFix?: boolean;
  commit?: boolean;
  limits?: Partial<Pick<AutopilotLimits, 'maxContinue' | 'maxReviewFix' | 'maxNetworkRetry'>>;
}

type ChatIncomingMessage = AnyRecord & {
  type?: string;
  command?: string;
  options?: AnyRecord & {
    autopilot?: AutopilotWsOptions;
    cwd?: string;
  };
  provider?: string;
  sessionId?: string;
  requestId?: string;
  allow?: unknown;
  updatedInput?: unknown;
  message?: unknown;
  rememberEntry?: unknown;
};

const DEFAULT_PROVIDER: LLMProvider = 'claude';

type ChatWebSocketDependencies = {
  queryClaudeSDK: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnCursor: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  queryCodex: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnGemini: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  abortClaudeSDKSession: (sessionId: string) => Promise<boolean>;
  abortCursorSession: (sessionId: string) => boolean;
  abortCodexSession: (sessionId: string) => boolean;
  abortGeminiSession: (sessionId: string) => boolean;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
  isCursorSessionActive: (sessionId: string) => boolean;
  isCodexSessionActive: (sessionId: string) => boolean;
  isGeminiSessionActive: (sessionId: string) => boolean;
  reconnectSessionWriter: (sessionId: string, ws: WebSocket) => boolean;
  getPendingApprovalsForSession: (sessionId: string) => unknown[];
  getActiveClaudeSDKSessions: () => unknown;
  getActiveCursorSessions: () => unknown;
  getActiveCodexSessions: () => unknown;
  getActiveGeminiSessions: () => unknown;
};

/**
 * Normalizes potentially invalid provider names coming from websocket payloads.
 */
function readProvider(value: unknown): LLMProvider {
  if (value === 'claude' || value === 'cursor' || value === 'codex' || value === 'gemini') {
    return value;
  }

  return DEFAULT_PROVIDER;
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const writer = new WebSocketWriter(ws, readRequestUserId(request));

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as ChatIncomingMessage;
      const messageType = data.type;
      if (!messageType) {
        throw new Error('Message type is required');
      }

      if (messageType === 'claude-command') {
        const autopilotOpts = data.options?.autopilot as AutopilotWsOptions | undefined;
        const isAutopilot =
          autopilotOpts != null &&
          (autopilotOpts.execution === true ||
            autopilotOpts.reviewFix === true ||
            autopilotOpts.commit === true);

        if (isAutopilot) {
          const orchestrator = getAutopilotOrchestrator();
          const rawCwd = typeof data.options?.cwd === 'string' ? data.options.cwd : process.cwd();
          const cwd = validateCwd(rawCwd);

          const toggles: AutopilotToggles = {
            execution: autopilotOpts.execution === true,
            reviewFix: autopilotOpts.reviewFix === true,
            commit: autopilotOpts.commit === true,
          };

          const limits: Partial<AutopilotLimits> = {};
          if (autopilotOpts.limits?.maxContinue != null) {
            limits.maxContinue = autopilotOpts.limits.maxContinue;
          }
          if (autopilotOpts.limits?.maxReviewFix != null) {
            limits.maxReviewFix = autopilotOpts.limits.maxReviewFix;
          }
          if (autopilotOpts.limits?.maxNetworkRetry != null) {
            limits.maxNetworkRetry = autopilotOpts.limits.maxNetworkRetry;
          }

          const startOpts: AutopilotStartOptions = {
            toggles,
            limits,
            cwd,
            cleanup: async (_reason: string) => {
              // Cleanup is handled by the SDK session cleanup chain.
              // The orchestrator calls this after the full autopilot lifecycle ends.
            },
          };

          // Register intent before the SDK call so bindIntent() can fire when
          // session_created arrives (writer.setSessionId is called by the SDK).
          orchestrator.registerIntent(writer, startOpts);

          // Wrap writer.setSessionId so we can intercept the first session_created
          // and bind the pending intent to the real sessionId.
          const originalSetSessionId = writer.setSessionId.bind(writer);
          let intentBound = false;
          writer.setSessionId = (sessionId: string) => {
            originalSetSessionId(sessionId);
            if (!intentBound) {
              intentBound = true;
              orchestrator.bindIntent(writer, sessionId);
            }
          };

          try {
            await dependencies.queryClaudeSDK(data.command ?? '', data.options, writer);
          } catch (err) {
            // If the SDK call fails before session_created, cancel the pending intent.
            if (!intentBound) {
              orchestrator.cancelIntent(writer);
            }
            throw err;
          }
          return;
        }

        await dependencies.queryClaudeSDK(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'cursor-command') {
        await dependencies.spawnCursor(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'codex-command') {
        await dependencies.queryCodex(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'gemini-command') {
        await dependencies.spawnGemini(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'cursor-resume') {
        await dependencies.spawnCursor(
          '',
          {
            sessionId: data.sessionId,
            resume: true,
            cwd: data.options?.cwd,
          },
          writer
        );
        return;
      }

      if (messageType === 'abort-session') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let success = false;

        if (provider === 'cursor') {
          success = dependencies.abortCursorSession(sessionId);
        } else if (provider === 'codex') {
          success = dependencies.abortCodexSession(sessionId);
        } else if (provider === 'gemini') {
          success = dependencies.abortGeminiSession(sessionId);
        } else {
          success = await dependencies.abortClaudeSDKSession(sessionId);
        }

        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider,
          })
        );
        return;
      }

      if (messageType === 'claude-permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          dependencies.resolveToolApproval(data.requestId, {
            allow: Boolean(data.allow),
            updatedInput: data.updatedInput,
            message: typeof data.message === 'string' ? data.message : undefined,
            rememberEntry: data.rememberEntry,
          });
        }
        return;
      }

      if (messageType === 'cursor-abort') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const success = dependencies.abortCursorSession(sessionId);
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider: 'cursor',
          })
        );
        return;
      }

      if (messageType === 'check-session-status') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let isActive = false;

        if (provider === 'cursor') {
          isActive = dependencies.isCursorSessionActive(sessionId);
        } else if (provider === 'codex') {
          isActive = dependencies.isCodexSessionActive(sessionId);
        } else if (provider === 'gemini') {
          isActive = dependencies.isGeminiSessionActive(sessionId);
        } else {
          isActive = dependencies.isClaudeSDKSessionActive(sessionId);
          if (isActive) {
            dependencies.reconnectSessionWriter(sessionId, ws);
          }
        }

        writer.send({
          type: 'session-status',
          sessionId,
          provider,
          isProcessing: isActive,
        });
        return;
      }

      if (messageType === 'get-pending-permissions') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (sessionId && dependencies.isClaudeSDKSessionActive(sessionId)) {
          const pending = dependencies.getPendingApprovalsForSession(sessionId);
          writer.send({
            type: 'pending-permissions-response',
            sessionId,
            data: pending,
          });
        }
        return;
      }

      if (messageType === 'get-active-sessions') {
        writer.send({
          type: 'active-sessions',
          sessions: {
            claude: dependencies.getActiveClaudeSDKSessions(),
            cursor: dependencies.getActiveCursorSessions(),
            codex: dependencies.getActiveCodexSessions(),
            gemini: dependencies.getActiveGeminiSessions(),
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      writer.send({
        type: 'error',
        error: message,
      });
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
