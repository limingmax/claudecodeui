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
 * Returns the latest (rightmost) match index for any pattern in the list,
 * or -1 if no pattern matches.
 *
 * The probe response buffer often contains the echoed prompt (e.g. PTY echo
 * in terminal mode) followed by the model's actual answer. The prompt itself
 * may include literal answer tokens like "COMPLETED" / "NOT_COMPLETED",
 * so a left-to-right match would pick up the prompt echo and produce the
 * wrong verdict. Picking the rightmost match biases toward the model's
 * latest output, which is the actual answer.
 */
function findLatestMatchIndex(text: string, patterns: RegExp[]): number {
  let latest = -1;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(text)) !== null) {
      if (match.index > latest) {
        latest = match.index;
      }
      if (match.index === globalPattern.lastIndex) {
        globalPattern.lastIndex++;
      }
    }
  }
  return latest;
}

/**
 * Parses the raw assistant text from a probe query and returns a verdict.
 *
 * For terminal autopilot, the buffer typically contains the echoed prompt
 * followed by the model's response. We scan for the rightmost match of
 * either COMPLETED or NOT_COMPLETED tokens — whichever appears later in
 * the text wins. This avoids the prompt-echo false positive where the
 * literal answer tokens inside the probe prompt are matched first.
 */
export function parseCompletionVerdict(text: string): CompletionVerdict {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'UNPARSED';
  }

  const completedAt = findLatestMatchIndex(trimmed, COMPLETED_PATTERNS);
  const notCompletedAt = findLatestMatchIndex(trimmed, NOT_COMPLETED_PATTERNS);

  if (completedAt < 0 && notCompletedAt < 0) {
    return 'UNPARSED';
  }
  if (notCompletedAt > completedAt) {
    return 'NOT_COMPLETED';
  }
  return 'COMPLETED';
}

/**
 * Returns the probe prompt to send to the model.
 * Uses the config override when present, otherwise falls back to the default.
 */
export function buildProbePrompt(config: Pick<AutopilotConfig, 'probePrompt'>): string {
  return config.probePrompt || DEFAULT_PROBE_PROMPT;
}
