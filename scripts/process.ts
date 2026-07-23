import { spawn } from 'node:child_process';

const TERMINATION_GRACE_MS = 2_000;

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly error?: Error;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export function secondsLabel(timeoutMs: number): string {
  const seconds = timeoutMs / 1_000;
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process tree may already have exited.
  }
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessExit> {
  return await new Promise((resolveExit) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolveExit({
        code: null,
        signal: null,
        timedOut: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    let timedOut = false;
    let processError: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalTree(child.pid, 'SIGTERM');
      escalation = setTimeout(() => signalTree(child.pid, 'SIGKILL'), TERMINATION_GRACE_MS);
      escalation.unref();
    }, options.timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => options.onStdout?.(chunk));
    child.stderr.on('data', (chunk: Buffer) => options.onStderr?.(chunk));
    child.once('error', (error) => {
      processError = error;
    });
    child.stdin.once('error', (error) => {
      processError ??= error;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      resolveExit({
        code: processError ? null : code,
        signal,
        timedOut,
        ...(processError ? { error: processError } : {}),
      });
    });
    child.stdin.end(options.input);
  });
}
