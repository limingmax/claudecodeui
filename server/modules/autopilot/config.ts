import type { AutopilotConfig, AutopilotLimits, AutopilotToggles } from './types.js';

export const DEFAULT_PROBE_PROMPT =
  "上一任务是否已完成？只能回答 'COMPLETED' 或 'NOT_COMPLETED'，不要解释，不要其他任何文字。";

export const DEFAULT_REVIEW_PROMPT =
  '请对上述代码变更进行评审，按 critical/high/medium/low 严重度返回 findings，' +
  '格式为 JSON 数组：[{"id":"<唯一id>","severity":"<级别>","message":"<描述>","file":"<可选>","line":<可选>}]。' +
  '若无问题返回空数组 []。不要输出 JSON 以外的任何内容。';

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseFloatEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function getDefaultLimits(): AutopilotLimits {
  return {
    maxContinue: parseIntEnv('AUTOPILOT_MAX_CONTINUE', 5),
    maxReviewFix: parseIntEnv('AUTOPILOT_MAX_REVIEW_FIX', 5),
    maxNetworkRetry: parseIntEnv('AUTOPILOT_MAX_NETWORK_RETRY', 3),
    backoffBaseMs: parseIntEnv('AUTOPILOT_NETWORK_BACKOFF_MS_BASE', 2000),
    toolApprovalTimeoutMs: parseIntEnv('AUTOPILOT_TOOL_APPROVAL_TIMEOUT_MS', 0),
    tokenBudgetExitThreshold: parseFloatEnv('AUTOPILOT_TOKEN_BUDGET_EXIT_THRESHOLD', 0.2),
  };
}

const DEFAULT_TOGGLES: AutopilotToggles = {
  execution: false,
  reviewFix: false,
  commit: false,
};

export function getDefaultConfig(): AutopilotConfig {
  return {
    toggles: { ...DEFAULT_TOGGLES },
    limits: getDefaultLimits(),
    probePrompt: process.env['AUTOPILOT_PROBE_PROMPT'] ?? DEFAULT_PROBE_PROMPT,
    reviewPrompt: process.env['AUTOPILOT_REVIEW_PROMPT'] ?? DEFAULT_REVIEW_PROMPT,
    commitTrailers: (process.env['AUTOPILOT_COMMIT_TRAILERS'] ?? 'true') !== 'false',
  };
}

export function mergeUserLimits(
  defaults: AutopilotLimits,
  userOverrides?: Partial<AutopilotLimits>,
): AutopilotLimits {
  if (!userOverrides) {
    return defaults;
  }
  return { ...defaults, ...userOverrides };
}
