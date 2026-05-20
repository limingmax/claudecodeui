import { parseCompletionVerdict } from '@/modules/autopilot/index.js';
import { PtyIdleDetector } from './idle-detector.js';
import { PtyOutputBuffer } from './pty-output-buffer.js';

type ShellAutopilotState =
  | 'IDLE'
  | 'EXECUTING'
  | 'WAITING_PROBE_RESPONSE'
  | 'REVIEWING'
  | 'WAITING_REVIEW_RESPONSE'
  | 'FIXING'
  | 'WAITING_FIX_RESPONSE'
  | 'COMMITTING'
  | 'DONE'
  | 'CANCELLED'
  | 'FAILED';

export interface ShellAutopilotConfig {
  idleMs: number;
  maxContinue: number;
  maxReviewFix: number;
  probePrompt: string;
  reviewPrompt: string;
  reviewFixEnabled: boolean;
  commitEnabled: boolean;
}

export interface PerformCommitResult {
  hash: string;
  skipped: boolean;
}

export interface ShellDriverDeps {
  writeToPty: (data: string) => void;
  sendWsEvent: (payload: object) => void;
  stripAnsi: (s: string) => string;
  config: ShellAutopilotConfig;
  performCommit?: (params: { commitMessage: string }) => Promise<PerformCommitResult>;
}

// ---------------------------------------------------------------------------
// Review findings parser
// ---------------------------------------------------------------------------

export interface ShellReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
}

export interface ShellReviewParseResult {
  findings: ShellReviewFinding[];
  hasHighOrCritical: boolean;
  hasFixable: boolean; // medium / high / critical — anything we want to fix
  isClean: boolean;
}

const REVIEW_SENTINEL = '[[AP_REVIEW_BEGIN]]';
const SEV_LINE_RE = /\[SEV:\s*(critical|high|medium|low)\s*\]\s*(.+)/i;

export function parseShellReviewFindings(text: string): ShellReviewParseResult {
  const idx = text.lastIndexOf(REVIEW_SENTINEL);
  if (idx < 0) {
    return { findings: [], hasHighOrCritical: false, hasFixable: false, isClean: false };
  }

  const after = text.slice(idx + REVIEW_SENTINEL.length);

  if (/\bNO_FINDINGS\b/.test(after)) {
    return { findings: [], hasHighOrCritical: false, hasFixable: false, isClean: true };
  }

  const findings: ShellReviewFinding[] = [];
  for (const line of after.split('\n')) {
    const m = line.match(SEV_LINE_RE);
    if (m) {
      findings.push({
        severity: m[1].toLowerCase() as ShellReviewFinding['severity'],
        message: m[2].trim(),
      });
    }
  }

  const hasHighOrCritical = findings.some(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );
  const hasFixable = findings.some(
    (f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium',
  );
  return { findings, hasHighOrCritical, hasFixable, isClean: findings.length === 0 };
}

export function findingsEqual(a: ShellReviewFinding[], b: ShellReviewFinding[]): boolean {
  const serialize = (arr: ShellReviewFinding[]) =>
    JSON.stringify(
      [...arr].sort((x, y) => x.severity.localeCompare(y.severity) || x.message.localeCompare(y.message)),
    );
  return serialize(a) === serialize(b);
}

// ---------------------------------------------------------------------------
// Commit message builder
// ---------------------------------------------------------------------------

function truncateLine(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function buildTerminalCommitMessage(
  continueCount: number,
  maxContinue: number,
  reviewFixCount: number,
  maxReviewFix: number,
  unresolvedFindings: ShellReviewFinding[],
): string {
  const lines: string[] = [];
  lines.push('chore(autopilot): terminal session changes');
  lines.push('');
  lines.push(
    'Auto-committed by terminal autopilot after the ' +
    'configured stages finished.',
  );
  lines.push(
    truncateLine(
      `Continue iterations: ${continueCount}/${maxContinue}`,
      100,
    ),
  );
  lines.push(
    truncateLine(
      `Review-fix iterations: ${reviewFixCount}/${maxReviewFix}`,
      100,
    ),
  );

  if (unresolvedFindings.length > 0) {
    lines.push('');
    lines.push('Unresolved findings (review-fix limit reached):');
    for (const f of unresolvedFindings) {
      lines.push(
        truncateLine(`- [SEV:${f.severity}] ${f.message}`, 100),
      );
    }
  }

  lines.push('');
  lines.push('Directive: autopilot-commit');
  lines.push('Confidence: medium');
  lines.push('Scope-risk: narrow');

  if (unresolvedFindings.length > 0) {
    lines.push(
      truncateLine(
        'Not-tested: review findings above were not resolved ' +
        'before commit',
        100,
      ),
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default review prompt with sentinel
// ---------------------------------------------------------------------------

export const DEFAULT_SHELL_REVIEW_PROMPT =
  '/oh-my-claudecode:code-review 输出 [[AP_REVIEW_BEGIN]] 后按 [SEV:级别] 描述 格式列出问题，无问题输出 NO_FINDINGS';

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class ShellAutopilotDriver {
  private state: ShellAutopilotState = 'IDLE';
  private continueCount = 0;
  private reviewFixCount = 0;
  private consecutiveUnparsedCount = 0;
  private previousFindings: ShellReviewFinding[] = [];
  private lastUnresolvedFindings: ShellReviewFinding[] = [];
  private idleDetector: PtyIdleDetector;
  private outputBuffer: PtyOutputBuffer;
  private active = false;
  private chunkCount = 0;
  private commitWaitCycles = 0;
  // Periodic probe timer — fires every idleMs in EXECUTING state. At each tick
  // we check whether the terminal is currently quiet (no chunk for at least
  // idleMs) and only then send the probe. This implements the user-requested
  // "定时询问" semantics.
  private periodicTimer: NodeJS.Timeout | null = null;
  private lastChunkAt: number = Date.now();
  private tickCount = 0;
  // Track the timestamp of the last COMPLETED probe response. Once we know
  // the task is "done", we DON'T re-probe until the terminal shows new
  // activity (lastChunkAt > lastCompletedAt). This implements the user's
  // requested "已问过且回复COMPLETED则跳过" semantics: the driver stays
  // alive (continues ticking) but only fires probes when there's genuinely
  // new activity to ask about.
  private lastCompletedAt: number | null = null;

  constructor(private readonly deps: ShellDriverDeps) {
    this.idleDetector = new PtyIdleDetector(deps.config.idleMs, () => this.onIdle());
    this.outputBuffer = new PtyOutputBuffer(deps.stripAnsi);
  }

  private log(msg: string, extra?: Record<string, unknown>): void {
    const ts = new Date().toISOString().slice(11, 23);
    const ctx = `state=${this.state} active=${this.active} continueCount=${this.continueCount}/${this.deps.config.maxContinue} reviewFixCount=${this.reviewFixCount}/${this.deps.config.maxReviewFix} tickCount=${this.tickCount}`;
    if (extra) {
      console.log(`[autopilot-shell ${ts}] ${msg} | ${ctx} | ${JSON.stringify(extra)}`);
    } else {
      console.log(`[autopilot-shell ${ts}] ${msg} | ${ctx}`);
    }
  }

  start(): void {
    this.active = true;
    this.lastChunkAt = Date.now();
    // Reset all counters in case the driver instance is being reused.
    this.continueCount = 0;
    this.reviewFixCount = 0;
    this.consecutiveUnparsedCount = 0;
    this.commitWaitCycles = 0;
    this.chunkCount = 0;
    this.tickCount = 0;
    this.lastCompletedAt = null;
    this.previousFindings = [];
    this.lastUnresolvedFindings = [];
    this.log('start() called', {
      idleMs: this.deps.config.idleMs,
      maxContinue: this.deps.config.maxContinue,
      maxReviewFix: this.deps.config.maxReviewFix,
      reviewFixEnabled: this.deps.config.reviewFixEnabled,
      commitEnabled: this.deps.config.commitEnabled,
    });
    this.transition('EXECUTING', 'started');
    this.startPeriodicTimer();
  }

  private startPeriodicTimer(): void {
    this.stopPeriodicTimer();
    this.log('starting periodic timer', { intervalMs: this.deps.config.idleMs });
    this.periodicTimer = setInterval(() => this.maybeProbe(), this.deps.config.idleMs);
  }

  private stopPeriodicTimer(): void {
    if (this.periodicTimer) {
      this.log('stopping periodic timer');
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private maybeProbe(): void {
    this.tickCount++;
    if (!this.active) {
      this.log('tick: driver inactive, stopping timer');
      this.stopPeriodicTimer();
      return;
    }
    if (this.state !== 'EXECUTING') {
      this.log('tick: skipping, not in EXECUTING');
      return;
    }

    // Quiet-check: only probe when the terminal has been silent for at least
    // idleMs. If chunks are still streaming, skip this tick and wait for the
    // next one. We deliberately use idleMs (not a smaller 1.5s) so streaming
    // CLI responses don't get interrupted by a probe.
    const sinceChunkMs = Date.now() - this.lastChunkAt;
    const requiredQuietMs = this.deps.config.idleMs;
    if (sinceChunkMs < requiredQuietMs) {
      this.log('tick: terminal still busy, skipping', {
        sinceChunkMs,
        requiredQuietMs,
        deficitMs: requiredQuietMs - sinceChunkMs,
      });
      return;
    }

    // Skip if we already got COMPLETED for the current activity window and
    // no new activity has happened since. We use lastChunkAt > lastCompletedAt
    // as the "new activity" signal — when the user sends a new prompt to CLI,
    // CLI produces fresh chunks that bump lastChunkAt above lastCompletedAt.
    if (this.lastCompletedAt !== null && this.lastChunkAt <= this.lastCompletedAt) {
      this.log('tick: already COMPLETED with no new activity, skipping', {
        lastCompletedAt: this.lastCompletedAt,
        lastChunkAt: this.lastChunkAt,
      });
      return;
    }

    this.log('tick: idle threshold met, sending probe', { sinceChunkMs, requiredQuietMs });
    this.outputBuffer.drain();
    // Pause idle detector during the 2.3s submit-delay window so a stray
    // idle-fire doesn't drain an empty buffer.
    this.idleDetector.pause();
    this.transition('WAITING_PROBE_RESPONSE', 'send_probe');
    // Claude Code CLI uses Ink (raw-mode TUI). Writing "text\r" in one
    // buffer triggers Ink's paste-detection: the prompt gets folded into
    // a [Pasted text] preview and \r is absorbed instead of submitting.
    // We must write text, wait for Ink to finish paste processing, then
    // write \r separately. This is the same pattern used by startReview /
    // startFix / startCommit.
    const promptText = this.deps.config.probePrompt;
    setTimeout(() => {
      if (!this.active) return;
      this.log('maybeProbe: writing prompt to PTY');
      this.deps.writeToPty(promptText);
      setTimeout(() => {
        if (!this.active) return;
        this.log('maybeProbe: writing \\r to submit');
        this.deps.writeToPty('\r');
        // Re-arm idle detector now that prompt is actually submitted.
        this.idleDetector.notifyChunk();
      }, 300);
    }, 2000);
  }

  onPtyChunk(chunk: string): void {
    if (!this.active) return;
    if (
      this.state === 'WAITING_PROBE_RESPONSE' ||
      this.state === 'WAITING_REVIEW_RESPONSE' ||
      this.state === 'WAITING_FIX_RESPONSE' ||
      this.state === 'COMMITTING'
    ) {
      this.outputBuffer.push(chunk);
    }
    this.chunkCount++;
    if (this.chunkCount % 50 === 0) {
      this.log('chunk batch', { chunkCount: this.chunkCount, lastBytes: chunk.length });
    }
    this.lastChunkAt = Date.now();
    this.idleDetector.notifyChunk();
  }

  onUserInput(): void {
    if (!this.active) return;
    this.lastChunkAt = Date.now();
    this.idleDetector.notifyChunk();
  }

  abort(): void {
    this.log('abort() called by user');
    this.active = false;
    this.stopPeriodicTimer();
    this.idleDetector.dispose();
    this.transition('CANCELLED', 'user_abort');
  }

  // ---- state handlers ----

  private onIdle(): void {
    if (!this.active) return;
    this.log('idle detector fired');

    // EXECUTING is driven by the periodic tick (maybeProbe), not by idle-decay.
    if (this.state === 'WAITING_PROBE_RESPONSE') {
      this.handleProbeResponseIdle();
    } else if (this.state === 'WAITING_REVIEW_RESPONSE') {
      this.handleReviewResponseIdle();
    } else if (this.state === 'WAITING_FIX_RESPONSE') {
      this.handleFixResponseIdle();
    } else if (this.state === 'COMMITTING') {
      this.handleCommittingIdle();
    } else {
      this.log('idle ignored — no handler for current state');
    }
  }

  private handleExecutingIdle(): void {
    // @deprecated — no longer wired. Periodic tick (maybeProbe) handles
    // the EXECUTING-state probe instead of idle-decay. Kept temporarily
    // as a safety net; can be removed in a follow-up.
    this.outputBuffer.drain();
    this.deps.writeToPty(this.deps.config.probePrompt + '\r');
    this.transition('WAITING_PROBE_RESPONSE', 'send_probe');
  }

  /**
   * Heuristic: returns true if the drained buffer looks like a TUI redraw
   * frame (Ink-style border/status only) rather than a real CLI response.
   * In that case we don't want to count it as an UNPARSED probe attempt —
   * just retry next tick.
   */
  private looksLikeTuiFrame(text: string): boolean {
    const trimmed = text.replace(/\s+/g, '').trim();
    if (trimmed.length < 50) return true;
    // Frame chars dominate
    const frameChars = (text.match(/[─│┌┐└┘├┤┬┴┼━┃┏┓┗┛⏵►]/g) || []).length;
    if (frameChars > 30 && frameChars * 2 > text.length / 4) return true;
    // No alphanumeric word ≥ 4 chars → likely just border + status
    if (!/[A-Za-z]{4,}/.test(text) && !/[一-龥]{2,}/.test(text)) return true;
    return false;
  }

  /**
   * Strip the probe prompt's own echo from the buffer before verdict parsing.
   *
   * The probe text contains both literal tokens "COMPLETED" and
   * "NOT_COMPLETED" (it says "只输出 COMPLETED 或 NOT_COMPLETED"). When the
   * PTY echoes the prompt back, parseCompletionVerdict sees both tokens and
   * picks the rightmost one (NOT_COMPLETED, since it appears later in the
   * prompt). The result: every probe gets falsely classified as
   * NOT_COMPLETED, and the driver loops forever.
   *
   * Fix: locate the literal probe-prompt text in the buffer and drop
   * everything up to and including the prompt's last char. Whatever
   * remains is what the CLI actually printed (its real answer + TUI
   * frames). If the prompt isn't found verbatim (e.g. line-wrapped or
   * partially redrawn), fall back to the original buffer.
   */
  private stripProbeEcho(text: string): string {
    const prompt = this.deps.config.probePrompt;
    if (!prompt) return text;

    // 1. Exact match first (cheapest)
    let idx = text.lastIndexOf(prompt);
    if (idx >= 0) return text.slice(idx + prompt.length);

    // 2. Whitespace-normalized regex match. Ink TUI may inject linebreaks
    //    or extra spaces at terminal column boundaries, breaking exact
    //    lastIndexOf. Build a regex that treats any run of whitespace in
    //    the prompt as `\s*` (zero or more whitespace) so column-wrapped
    //    echoes still match.
    const escaped = prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexible = escaped.replace(/\s+/g, '\\s*');
    try {
      const re = new RegExp(flexible);
      const m = re.exec(text);
      if (m && typeof m.index === 'number') {
        return text.slice(m.index + m[0].length);
      }
    } catch {
      // Bad regex — skip and try anchors
    }

    // 3. Anchor fallback for Chinese default prompt
    const anchors = [
      '不要任何其他文字、解释或修饰',
      '不要其他任何文字',
      '只输出 COMPLETED 或 NOT_COMPLETED',
      '只输出COMPLETED或NOT_COMPLETED',
    ];
    for (const a of anchors) {
      idx = text.lastIndexOf(a);
      if (idx >= 0) return text.slice(idx + a.length);
    }

    // 4. All strategies failed — log so operator knows. Return original
    //    text; downstream will see both COMPLETED and NOT_COMPLETED tokens
    //    from the echo and likely classify as NOT_COMPLETED, but the
    //    `looksLikeTuiFrame` heuristic in handleProbeResponseIdle will
    //    catch most of these.
    this.log('stripProbeEcho: all strategies failed — custom prompt? returning unstripped buffer', {
      promptHead: prompt.slice(0, 60),
      textHead: text.slice(0, 60),
    });
    return text;
  }

  private handleProbeResponseIdle(): void {
    const rawText = this.outputBuffer.drain();
    // Strip the probe-prompt echo so its literal "COMPLETED"/"NOT_COMPLETED"
    // tokens don't poison the verdict parser.
    const text = this.stripProbeEcho(rawText);
    const verdict = parseCompletionVerdict(text);
    // Diagnostic: search the post-strip buffer for COMPLETED-ish tokens.
    const completedHits = (text.match(/\bCOMPLETED\b/gi) || []).length;
    const notCompletedHits = (text.match(/\bNOT[_\s]?COMPLETED\b/gi) || []).length;
    const completedZhHits = (text.match(/\b(完成|已完成)\b/g) || []).length;
    this.log('probe response parsed', {
      verdict,
      rawBufferBytes: rawText.length,
      strippedBufferBytes: text.length,
      completedHits,
      notCompletedHits,
      completedZhHits,
      head200: text.slice(0, 200),
      tail200: text.slice(-200),
      ...(text.length > 600 ? { mid400: text.slice(Math.floor(text.length / 2) - 200, Math.floor(text.length / 2) + 200) } : {}),
    });
    this.deps.sendWsEvent({ kind: 'autopilot.completion_probe_result', verdict, snippet: text.slice(-200) });

    if (verdict === 'COMPLETED') {
      this.consecutiveUnparsedCount = 0;
      this.log('verdict=COMPLETED → onProbeCompleted');
      this.onProbeCompleted();
      return;
    }

    if (verdict === 'UNPARSED') {
      // TUI-frame heuristic: if the buffer is just a redraw frame (Ink
      // border + status bar), don't count it as a parse failure — retry
      // silently next tick.
      if (this.looksLikeTuiFrame(text)) {
        this.log('UNPARSED but looks like TUI frame → silent retry (no count bump)');
        this.lastChunkAt = Date.now();
        this.transition('EXECUTING', 'probe_tui_frame');
        return;
      }
      this.consecutiveUnparsedCount++;
      this.log('verdict=UNPARSED', {
        consecutiveUnparsedCount: this.consecutiveUnparsedCount,
      });
      if (this.consecutiveUnparsedCount >= 3) {
        this.log('UNPARSED 3 times in a row → FAILED');
        this.active = false;
        this.stopPeriodicTimer();
        this.idleDetector.dispose();
        this.deps.sendWsEvent({
          kind: 'autopilot.limit_reached',
          limitType: 'probe_unparseable',
          count: this.consecutiveUnparsedCount,
        });
        this.transition('FAILED', 'probe_unparseable');
        return;
      }
      // Don't send "继续" — we don't know whether the task is actually done.
      // Just transition back to EXECUTING so the next periodic tick can
      // probe again after another idle window. This avoids the loop where
      // we mistake parse-failures for NOT_COMPLETED and keep poking the CLI.
      this.log('UNPARSED → returning to EXECUTING, will retry next tick');
      // Reset lastChunkAt so the next periodic tick has to wait at least one
      // full idle window before probing again. Without this, the next tick
      // would see lastChunkAt frozen at pre-probe time and fire instantly.
      this.lastChunkAt = Date.now();
      this.transition('EXECUTING', 'probe_unparsed_retry');
      return;
    }

    // Genuine NOT_COMPLETED
    this.consecutiveUnparsedCount = 0;
    this.continueCount++;
    this.log('verdict=NOT_COMPLETED → sending 继续', { continueCount: this.continueCount });
    if (this.continueCount >= this.deps.config.maxContinue) {
      this.log('maxContinue exceeded → keep alive (no further 继续)');
      this.deps.sendWsEvent({
        kind: 'autopilot.limit_reached',
        limitType: 'continue',
        count: this.continueCount,
        max: this.deps.config.maxContinue,
      });
      this.finish();
      return;
    }
    this.deps.writeToPty('继续\r');
    this.deps.sendWsEvent({
      kind: 'autopilot.iteration',
      type: 'continue',
      count: this.continueCount,
      max: this.deps.config.maxContinue,
    });
    this.transition('EXECUTING', 'send_continue');
  }

  private onProbeCompleted(): void {
    this.log('onProbeCompleted', {
      reviewFixEnabled: this.deps.config.reviewFixEnabled,
      commitEnabled: this.deps.config.commitEnabled,
    });
    // Mark this moment so future ticks skip probing until new CLI activity.
    // We update lastCompletedAt regardless of whether stages are configured —
    // even when stages run, after they finish we want the driver to keep
    // ticking but not re-ask "are you done?" until the user does something.
    // Also sync lastChunkAt → lastCompletedAt so the probe-response chunks
    // (which slightly post-date the parse) don't falsely satisfy the
    // "new activity since COMPLETED" check on the very next tick.
    this.lastCompletedAt = Date.now();
    this.lastChunkAt = this.lastCompletedAt;
    if (this.deps.config.reviewFixEnabled) {
      this.startReview();
      return;
    }
    if (this.deps.config.commitEnabled) {
      this.startCommit([]);
      return;
    }
    // No stages configured → stay alive in EXECUTING, but skip probes until
    // the user sends fresh input (lastChunkAt > lastCompletedAt).
    this.log('no stages configured → keeping driver alive, returning to EXECUTING');
    this.deps.sendWsEvent({
      kind: 'autopilot.completion_probe_result',
      verdict: 'COMPLETED',
      snippet: '(no stages configured — staying alive, idle)',
    });
    this.transition('EXECUTING', 'completed_no_stage');
  }

  private startReview(): void {
    this.outputBuffer.drain();
    // Pause idle detector during the 2.3s submit-delay window so a stray
    // idle-fire doesn't drain an empty buffer and produce a phantom
    // "sentinel missing" result before the prompt is even submitted.
    this.idleDetector.pause();
    const prompt = '/oh-my-claudecode:code-review 输出 [[AP_REVIEW_BEGIN]] 后按 [SEV:级别] 描述 格式列出问题，无问题输出 NO_FINDINGS';
    this.log('startReview: sending OMC code-review command', { prompt });
    setTimeout(() => {
      if (!this.active) return;
      this.log('startReview: writing prompt to PTY');
      this.deps.writeToPty(prompt);
      setTimeout(() => {
        if (!this.active) return;
        this.log('startReview: writing \\r to submit');
        this.deps.writeToPty('\r');
        // Re-arm idle detector now that the prompt is actually submitted
        // and CLI output is expected.
        this.idleDetector.notifyChunk();
      }, 300);
    }, 2000);
    this.transition('WAITING_REVIEW_RESPONSE', 'send_review');
  }

  private handleReviewResponseIdle(): void {
    const text = this.outputBuffer.drain();
    this.log('handleReviewResponseIdle: parsing findings', {
      bufferBytes: text.length,
      tail400: text.slice(-400),
    });

    let result: ShellReviewParseResult;
    try {
      result = parseShellReviewFindings(text);
      this.log('parseShellReviewFindings result', {
        isClean: result.isClean,
        hasHighOrCritical: result.hasHighOrCritical,
        findingsCount: result.findings.length,
        findings: result.findings,
      });
    } catch (err) {
      this.log('parseShellReviewFindings threw error → FAILED', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.active = false;
      this.stopPeriodicTimer();
      this.idleDetector.dispose();
      this.transition('FAILED', 'review_parse_error');
      return;
    }
    this.deps.sendWsEvent({
      kind: 'autopilot.review_result',
      findings: result.findings,
      isClean: result.isClean,
      hasHighOrCritical: result.hasHighOrCritical,
      reviewFixCount: this.reviewFixCount,
    });

    // Sentinel missing / buffer overflow — treat as unresolvable
    if (!result.isClean && result.findings.length === 0 && !result.hasHighOrCritical) {
      this.log('review unparseable (sentinel missing) → treat as unresolved');
      this.deps.sendWsEvent({
        kind: 'autopilot.limit_reached',
        limitType: 'review_unparseable',
        count: this.reviewFixCount,
        max: this.deps.config.maxReviewFix,
      });
      this.lastUnresolvedFindings = [
        { severity: 'high', message: '(review output unparseable — sentinel missing or buffer overflow)' },
      ];
      if (this.deps.config.commitEnabled) {
        this.startCommit(this.lastUnresolvedFindings);
      } else {
        this.finish();
      }
      return;
    }

    if (!result.hasFixable || result.isClean) {
      this.log('review has no fixable findings (medium+) → next stage', {
        findingsCount: result.findings.length,
        lowCount: result.findings.filter((f) => f.severity === 'low').length,
      });
      this.previousFindings = [];
      if (this.deps.config.commitEnabled) {
        this.startCommit([]);
      } else {
        this.finish();
      }
      return;
    }

    // Filter to only fixable findings (medium+) for the fix loop. Low-severity
    // items don't trigger fixes but are still surfaced in the WS event above.
    const fixableFindings = result.findings.filter(
      (f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium',
    );

    const deadLoop = findingsEqual(fixableFindings, this.previousFindings);
    if (deadLoop || this.reviewFixCount >= this.deps.config.maxReviewFix) {
      this.log('review fix loop ended', {
        reason: deadLoop ? 'dead_loop' : 'max_reached',
        reviewFixCount: this.reviewFixCount,
      });
      this.deps.sendWsEvent({
        kind: 'autopilot.limit_reached',
        limitType: 'reviewFix',
        count: this.reviewFixCount,
        max: this.deps.config.maxReviewFix,
        reason: deadLoop ? 'dead_loop' : 'max_reached',
      });
      this.lastUnresolvedFindings = fixableFindings;
      if (this.deps.config.commitEnabled) {
        this.startCommit(fixableFindings);
      } else {
        this.finish();
      }
      return;
    }

    // Needs fix
    this.log('review found fixable issues → entering fix loop', {
      fixableCount: fixableFindings.length,
      reviewFixCount: this.reviewFixCount,
    });
    this.previousFindings = fixableFindings;
    this.reviewFixCount++;
    this.startFix(fixableFindings);
  }

  private startFix(findings: ShellReviewFinding[]): void {
    const fixLines = findings
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      .map((f) => `[SEV:${f.severity}] ${f.message}`)
      .join(' | ');
    const fixPrompt =
      '请修复以下 review 发现的问题（按严重度从高到低）：' +
      fixLines +
      ' 完成后请自行测试，确保改动有效。';
    this.outputBuffer.drain();
    // Same as startReview: pause idle detector during the submit-delay window
    // to avoid a phantom idle-fire on empty buffer.
    this.idleDetector.pause();
    this.log('startFix: sending fix prompt', {
      promptLen: fixPrompt.length,
      findingsCount: findings.length,
      findings,
    });
    setTimeout(() => {
      if (!this.active) return;
      this.log('startFix: writing prompt to PTY');
      this.deps.writeToPty(fixPrompt);
      setTimeout(() => {
        if (!this.active) return;
        this.log('startFix: writing \\r to submit');
        this.deps.writeToPty('\r');
        this.idleDetector.notifyChunk();
      }, 300);
    }, 2000);
    this.transition('WAITING_FIX_RESPONSE', 'send_fix');
  }

  private handleFixResponseIdle(): void {
    this.log('handleFixResponseIdle: fix turn done → re-running review');
    this.outputBuffer.drain();
    this.deps.sendWsEvent({
      kind: 'autopilot.iteration',
      type: 'reviewFix',
      count: this.reviewFixCount,
      max: this.deps.config.maxReviewFix,
    });
    this.startReview();
  }

  private handleCommittingIdle(): void {
    const text = this.outputBuffer.drain();
    const doneIdx = text.lastIndexOf('[[AP_COMMIT_DONE]]');
    const failIdx = text.lastIndexOf('[[AP_COMMIT_FAIL]]');
    this.log('handleCommittingIdle', {
      doneIdx,
      failIdx,
      bufferBytes: text.length,
      waitCycles: this.commitWaitCycles,
      tail200: text.slice(-200),
    });

    if (doneIdx > failIdx && doneIdx >= 0) {
      this.log('commit DONE marker found → keep alive');
      this.deps.sendWsEvent({ kind: 'autopilot.commit_done', skipped: false });
      this.finish();
      return;
    }
    if (failIdx >= 0) {
      this.active = false;
      this.stopPeriodicTimer();
      this.idleDetector.dispose();
      const errSnippet = text.slice(failIdx, failIdx + 300);
      this.log('commit FAIL marker found → FAILED', { errSnippet });
      this.deps.sendWsEvent({ kind: 'autopilot.commit_error', error: errSnippet });
      this.transition('FAILED', 'commit_failed');
      return;
    }
    this.commitWaitCycles++;
    if (this.commitWaitCycles >= 2) {
      this.active = false;
      this.stopPeriodicTimer();
      this.idleDetector.dispose();
      this.log('commit timed out without DONE/FAIL marker → FAILED');
      this.deps.sendWsEvent({ kind: 'autopilot.commit_error', error: 'Commit response missing DONE/FAIL marker; CLI may not have followed instructions.' });
      this.transition('FAILED', 'commit_failed');
      return;
    }
    this.log('committing: no marker yet, waiting another idle cycle');
    this.idleDetector.notifyChunk();
  }

  private startCommit(unresolvedFindings: ShellReviewFinding[]): void {
    this.idleDetector.pause();
    // Reset wait counter so a re-entry into commit doesn't time out instantly.
    this.commitWaitCycles = 0;
    this.transition('COMMITTING', 'start_commit');

    const hasUnresolved = unresolvedFindings.length > 0;
    const commitPrompt =
      '请用 git add -u 加 git commit 提交改动，message 含 Directive: autopilot-commit。' +
      '禁止 git push。' +
      (hasUnresolved ? 'message 里加 Not-tested 提及未解决的 review 问题。' : '') +
      '完成输出 [[AP_COMMIT_DONE]]，失败输出 [[AP_COMMIT_FAIL]]+原因。';

    this.outputBuffer.drain();
    this.log('startCommit: sending commit prompt', {
      promptLen: commitPrompt.length,
      hasUnresolved,
      findings: unresolvedFindings.length,
    });
    setTimeout(() => {
      if (!this.active) return;
      this.log('startCommit: writing prompt to PTY');
      this.deps.writeToPty(commitPrompt);
      setTimeout(() => {
        if (!this.active) return;
        this.log('startCommit: writing \\r to submit');
        this.deps.writeToPty('\r');
        this.idleDetector.notifyChunk();
      }, 300);
    }, 2000);
  }

  /**
   * Keep the driver alive after the configured stage chain finishes.
   *
   * Previously this was `finish()` which killed the driver (DONE). The
   * user's actual requirement is that the driver should keep ticking and
   * re-probe only when there is new CLI activity. So instead of ending,
   * we:
   *   1. Record lastCompletedAt so future ticks skip probing until the
   *      user does something new in the terminal.
   *   2. Sync lastChunkAt to lastCompletedAt so the trailing stage-
   *      response chunks don't falsely satisfy the "new activity" check.
   *   3. Transition back to EXECUTING and let the periodic tick run.
   *
   * The driver still ends naturally on:
   *   - explicit user abort() → CANCELLED
   *   - true error paths (review_parse_error etc.) → FAILED
   */
  private finish(): void {
    this.log('finish() → keep alive, returning to EXECUTING');
    this.lastCompletedAt = Date.now();
    this.lastChunkAt = this.lastCompletedAt;
    // Counters reset so the next round starts fresh.
    this.continueCount = 0;
    this.reviewFixCount = 0;
    this.consecutiveUnparsedCount = 0;
    this.commitWaitCycles = 0;
    this.previousFindings = [];
    this.idleDetector.pause();
    this.transition('EXECUTING', 'stage_chain_completed');
  }

  private transition(to: ShellAutopilotState, reason: string): void {
    const from = this.state;
    this.state = to;
    this.log('STATE TRANSITION', { from, to, reason });
    this.deps.sendWsEvent({
      kind: 'autopilot.state_changed',
      from,
      to,
      reason,
      counters: {
        continue: this.continueCount,
        reviewFix: this.reviewFixCount,
        networkRetry: 0,
      },
    });
    if (to === 'DONE') {
      this.deps.sendWsEvent({
        kind: 'autopilot.completed',
        summary: {
          iterations: this.continueCount,
          reviewFixIterations: this.reviewFixCount,
          unresolvedFindings: this.lastUnresolvedFindings,
        },
      });
    } else if (to === 'CANCELLED') {
      this.deps.sendWsEvent({ kind: 'autopilot.cancelled', cancelledInState: from });
    } else if (to === 'FAILED') {
      this.deps.sendWsEvent({ kind: 'autopilot.failed', lastState: from });
    }
  }
}

function severityRank(sev: string): number {
  switch (sev) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    case 'low': return 3;
    default: return 4;
  }
}
