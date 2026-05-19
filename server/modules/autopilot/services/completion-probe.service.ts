// Completion probe — pure functions, no side effects.
// Parses the model's verdict from a probe response and builds probe prompts.

import type { AutopilotConfig } from '../types.js';
import { DEFAULT_PROBE_PROMPT } from '../config.js';

export type CompletionVerdict = 'COMPLETED' | 'NOT_COMPLETED' | 'UNPARSED';

const COMPLETED_PATTERNS = [
  /\bCOMPLETED\b/i,
  /\b完成\b/,
  /\b已完成\b/,
  /\btask\s+(?:is\s+)?(?:done|complete|finished)\b/i,
];

const NOT_COMPLETED_PATTERNS = [
  /\bNOT[_\s]COMPLETED\b/i,
  /\b未完成\b/,
  /\b还没\b/,
  /\b尚未\b/,
  /\b没有完成\b/,
  /\bnot\s+(?:yet\s+)?(?:done|complete|finished)\b/i,
];

/**
 * Parses the raw assistant text from a probe query and returns a verdict.
 * Matching is order-sensitive: NOT_COMPLETED patterns are checked first to
 * avoid false positives when the model says "NOT COMPLETED".
 */
export function parseCompletionVerdict(text: string): CompletionVerdict {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'UNPARSED';
  }

  for (const pattern of NOT_COMPLETED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'NOT_COMPLETED';
    }
  }

  for (const pattern of COMPLETED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'COMPLETED';
    }
  }

  return 'UNPARSED';
}

/**
 * Returns the probe prompt to send to the model.
 * Uses the config override when present, otherwise falls back to the default.
 */
export function buildProbePrompt(config: Pick<AutopilotConfig, 'probePrompt'>): string {
  return config.probePrompt || DEFAULT_PROBE_PROMPT;
}
