import { spawn } from 'node:child_process';
import type { ToolResult } from '../types.js';

export function runBash(
  tokens: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', `exec ${tokens.join(' ')}`], {
      cwd,
      detached: true,
      env: {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let remaining = maxBytes;
    let truncated = false;
    let timedOut = false;

    function capture(target: Buffer[], chunk: Buffer): void {
      const accepted = Math.min(remaining, chunk.length);
      if (accepted > 0) target.push(chunk.subarray(0, accepted));
      remaining -= accepted;
      truncated ||= accepted < chunk.length;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Bash could not start: ${error.message}` });
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      const output = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal,
      };
      const error = timedOut
        ? `Bash timed out after ${timeoutMs} ms`
        : exitCode === 0
          ? undefined
          : `Bash exited with ${exitCode ?? signal ?? 'unknown status'}`;
      resolve(error ? { ok: false, output, error, truncated } : { ok: true, output, truncated });
    });
  });
}
