// Commit service — runs git operations for autopilot sessions.
// Never pushes. Calls queryClaudeSDK via injected queryFn to generate messages.

import { spawn as _nodeSpawn } from 'node:child_process';
import type { ReviewFinding } from '../types.js';
import type { WebSocketWriter } from '@/modules/websocket/index.js';

// ---------------------------------------------------------------------------
// Spawn injection (for testing)
// ---------------------------------------------------------------------------

type SpawnFn = typeof _nodeSpawn;
let _spawnImpl: SpawnFn = _nodeSpawn;

/** Inject a mock spawn implementation for testing. Pass null/undefined to reset. */
export function setSpawnFn(fn: SpawnFn | null | undefined): void {
  _spawnImpl = fn ?? _nodeSpawn;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitOptions {
  cwd: string;
  ws: WebSocketWriter;
  sessionId: string;
  summary?: string;
  unresolvedFindings?: ReviewFinding[];
}

export interface CommitResult {
  skipped: boolean;
  hash?: string;
}

// Injected by orchestrator at startup — avoids circular import with claude-sdk.js.
export type QueryFn = (
  prompt: string,
  options: Record<string, unknown>,
  ws: WebSocketWriter,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function spawnAsync(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  // Safety: never allow git push through this helper.
  if (command === 'git' && args.includes('push')) {
    throw new Error('git push is not allowed from autopilot commit service');
  }

  return new Promise((resolve, reject) => {
    const child = _spawnImpl(command, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`);
        reject(err);
      }
    });
  });
}

async function getChangedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await spawnAsync('git', ['status', '--porcelain'], cwd);
  return stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * Extracts the commit message text from the model's raw response.
 * Strips markdown code fences if present.
 */
function extractCommitMessage(raw: string): string {
  const fenceMatch = raw.match(/```(?:text|commit)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return raw.trim();
}

function buildCommitPrompt(
  changedFiles: string[],
  unresolvedFindings?: ReviewFinding[],
): string {
  const fileList = changedFiles.map((f) => `  - ${f}`).join('\n');

  let prompt =
    '请根据以下变更文件列表，严格遵循 CLAUDE.md 中的 commit 规范，生成一条 git commit message。\n' +
    '要求：\n' +
    '1. 使用 conventional commit 格式（type(scope): subject）\n' +
    '2. 必须包含 trailer: Directive: autopilot-commit\n' +
    '3. 只输出 commit message 文本，不要任何解释\n\n' +
    `变更文件：\n${fileList}`;

  if (unresolvedFindings && unresolvedFindings.length > 0) {
    const findingSummary = unresolvedFindings
      .map((f) => `${f.severity}: ${f.message}${f.file ? ` (${f.file})` : ''}`)
      .join('; ');
    prompt += `\n\n未解决的 review findings（请加入 Not-tested trailer）：\n${findingSummary}`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _queryFn: QueryFn | null = null;

/** Called once at server startup to inject the SDK query function. */
export function setCommitQueryFn(fn: QueryFn): void {
  _queryFn = fn;
}

/**
 * Generates a commit message via the model, stages all changes, and commits.
 * Returns { skipped: true } when there is nothing to commit.
 * Throws on git errors so the orchestrator can enqueue commit_error.
 */
export async function commitWithAutopilot(opts: CommitOptions): Promise<CommitResult> {
  const { cwd, ws, sessionId, unresolvedFindings } = opts;

  const changedFiles = await getChangedFiles(cwd);
  if (changedFiles.length === 0) {
    return { skipped: true };
  }

  // Generate commit message via model.
  let commitMessage = 'chore: autopilot session changes\n\nDirective: autopilot-commit';

  if (_queryFn) {
    const collectedText: string[] = [];

    // We need to capture the model's text output. We use a lightweight
    // wrapper ws that intercepts send() calls to collect assistant text.
    const capturingWs = {
      ...ws,
      send(data: unknown): void {
        try {
          const msg = typeof data === 'string' ? JSON.parse(data) : data;
          if (
            msg &&
            typeof msg === 'object' &&
            (msg as Record<string, unknown>)['type'] === 'assistant'
          ) {
            const content = (msg as Record<string, unknown>)['content'];
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === 'object' &&
                  (block as Record<string, unknown>)['type'] === 'text'
                ) {
                  collectedText.push(String((block as Record<string, unknown>)['text'] ?? ''));
                }
              }
            }
          }
        } catch {
          // Ignore parse errors from non-JSON sends.
        }
        ws.send(data);
      },
    } as WebSocketWriter;

    const prompt = buildCommitPrompt(changedFiles, unresolvedFindings);
    await _queryFn(
      prompt,
      {
        sessionId,
        // Explicitly clear autopilot flag to prevent recursive triggering.
        autopilot: undefined,
      },
      capturingWs,
    );

    const rawText = collectedText.join('').trim();
    if (rawText) {
      commitMessage = extractCommitMessage(rawText);
    }
  }

  // Stage tracked modifications and deletions only.
  // Using -u (--update) instead of -A intentionally: -u only stages changes to
  // already-tracked files, so untracked new files (including any accidentally
  // created .env / secret files) are never auto-committed. This is a deliberate
  // security-conservative choice — new files must be explicitly `git add`-ed by
  // the user before they can be included in a commit.
  await spawnAsync('git', ['add', '-u'], cwd);

  // Commit with the generated message.
  await spawnAsync('git', ['commit', '-m', commitMessage], cwd);

  // Retrieve the new commit hash.
  const { stdout: hashOut } = await spawnAsync(
    'git',
    ['rev-parse', '--short', 'HEAD'],
    cwd,
  );
  const hash = hashOut.trim();

  return { skipped: false, hash };
}
