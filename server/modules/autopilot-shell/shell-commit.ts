// Terminal autopilot commit helper — no SDK dependency, no git push.
// Mirrors the spawn pattern from autopilot/services/commit.service.ts.

import { spawn } from 'node:child_process';
import path from 'node:path';

export interface PerformCommitParams {
  commitMessage: string;
  cwd: string;
}

export interface PerformCommitResult {
  hash: string;
  skipped: boolean;
}

function spawnAsync(
  command: string,
  args: string[],
  cwd: string,
  stdinData?: string,
): Promise<{ stdout: string; stderr: string }> {
  // Safety: never allow git push through this helper.
  if (command === 'git' && args.includes('push')) {
    throw new Error('git push is not allowed from terminal autopilot commit');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
        reject(
          new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`),
        );
      }
    });

    if (stdinData !== undefined) {
      child.stdin.end(stdinData, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

function validateCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  const root =
    process.env['WORKSPACE_ROOT']
      ? path.resolve(process.env['WORKSPACE_ROOT'])
      : path.resolve(process.cwd());

  // Allow the resolved path if it equals root or starts with root separator.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `Commit cwd ${resolved} is outside allowed root ${root}`,
    );
  }
  return resolved;
}

export async function performTerminalCommit(
  params: PerformCommitParams,
): Promise<PerformCommitResult> {
  const cwd = validateCwd(params.cwd);

  const { stdout: statusOut } = await spawnAsync(
    'git',
    ['status', '--porcelain'],
    cwd,
  );
  const changedFiles = statusOut
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  if (changedFiles.length === 0) {
    return { hash: '', skipped: true };
  }

  // Stage only tracked changes — same security reasoning as chat-mode commit.
  await spawnAsync('git', ['add', '-u'], cwd);

  // Pass message via stdin to avoid shell-escaping issues with special chars.
  await spawnAsync(
    'git',
    ['commit', '-F', '-'],
    cwd,
    params.commitMessage,
  );

  const { stdout: hashOut } = await spawnAsync(
    'git',
    ['rev-parse', '--short', 'HEAD'],
    cwd,
  );

  return { hash: hashOut.trim(), skipped: false };
}
