import { spawn } from 'node:child_process';

import { buildSystemBinaryEnv } from '../../utils/system-binary-env';
import type { PluginExecOptions, PluginExecResult } from './types';

const MAX_CAPTURED_OUTPUT_CHARS = 4 * 1024 * 1024;

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURED_OUTPUT_CHARS) return current;
  return (current + chunk).slice(0, MAX_CAPTURED_OUTPUT_CHARS);
}

/**
 * Runs `command` without a shell and collects its output. Resolves with the exit code on any exit,
 * including non-zero; rejects when the binary cannot start, the timeout passes, or `signal` aborts.
 */
export function execPluginCommand(
  command: string,
  args: string[],
  options: PluginExecOptions = {},
): Promise<PluginExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('Command aborted.', 'AbortError'));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...buildSystemBinaryEnv(), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      finish();
    };

    const killWith = (error: Error): void => {
      settle(() => reject(error));
      child.kill('SIGTERM');
    };

    function onAbort(): void {
      killWith(new DOMException('Command aborted.', 'AbortError'));
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeout = setTimeout(
        () => killWith(new Error(`${command} timed out after ${options.timeoutMs} ms.`)),
        options.timeoutMs,
      );
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    // A child that exits without reading stdin raises EPIPE here; the exit code tells the story.
    child.stdin.on('error', () => {});

    child.on('error', (error) => settle(() => reject(error)));
    child.on('close', (exitCode) => settle(() => resolve({ exitCode, stdout, stderr })));

    child.stdin.end(options.stdin ?? '');
  });
}
