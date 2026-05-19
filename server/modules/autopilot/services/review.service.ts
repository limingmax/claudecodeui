// Review service — parses reviewer findings from raw model output.
// Pure functions; no side effects.

import type { AutopilotConfig, ReviewFinding } from '../types.js';
import { DEFAULT_REVIEW_PROMPT } from '../config.js';

export interface ReviewResult {
  findings: ReviewFinding[];
  hasHighOrCritical: boolean;
  raw: string;
}

/**
 * Extracts a JSON array from raw text that may contain markdown code fences
 * or surrounding prose.
 */
function extractJsonArray(raw: string): string | null {
  // Try to find a JSON array inside a markdown code block first.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('[')) {
      return inner;
    }
  }

  // Fall back to the first '[' ... ']' span in the text.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    return raw.slice(start, end + 1);
  }

  return null;
}

function isValidFinding(value: unknown): value is ReviewFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['severity'] === 'string' &&
    ['critical', 'high', 'medium', 'low'].includes(obj['severity'] as string) &&
    typeof obj['message'] === 'string'
  );
}

/**
 * Parses the raw reviewer response into structured findings.
 * On any parse failure, returns an empty findings list so the flow
 * proceeds to commit rather than looping indefinitely.
 */
export function parseReviewResult(raw: string): ReviewResult {
  const jsonStr = extractJsonArray(raw);
  if (!jsonStr) {
    return { findings: [], hasHighOrCritical: false, raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { findings: [], hasHighOrCritical: false, raw };
  }

  if (!Array.isArray(parsed)) {
    return { findings: [], hasHighOrCritical: false, raw };
  }

  const findings: ReviewFinding[] = parsed.filter(isValidFinding);
  const hasHighOrCritical = findings.some(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );

  return { findings, hasHighOrCritical, raw };
}

/**
 * Returns true when two finding lists are semantically identical
 * (same ids, regardless of order). Used by the reducer to detect
 * a stuck review loop.
 */
export function findingsEqual(a: ReviewFinding[], b: ReviewFinding[]): boolean {
  const idsA = [...a].map((f) => f.id).sort().join(',');
  const idsB = [...b].map((f) => f.id).sort().join(',');
  return idsA === idsB;
}

/**
 * Builds the review prompt, optionally appending a changed-files list.
 */
export function buildReviewPrompt(
  config: Pick<AutopilotConfig, 'reviewPrompt'>,
  changedFiles?: string[],
): string {
  const base = config.reviewPrompt || DEFAULT_REVIEW_PROMPT;
  if (!changedFiles || changedFiles.length === 0) {
    return base;
  }
  const fileList = changedFiles.map((f) => `  - ${f}`).join('\n');
  return `${base}\n\n变更文件列表：\n${fileList}`;
}
