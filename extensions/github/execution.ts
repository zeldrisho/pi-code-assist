import { spawn } from 'node:child_process';
import {
  bounded,
  decodeUtf8,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  type ExecResult,
} from './output.ts';

export const MAX_API_BYTES = 1_000_000;

export async function execStreaming(
  command: string,
  args: string[],
  signal?: AbortSignal,
  keepTail = false,
  maxBytes = MAX_OUTPUT_BYTES,
  maxLines = MAX_OUTPUT_LINES,
  rejectOverflow = false,
  timeout = 120_000,
): Promise<ExecResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let escalation: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (child.pid !== undefined) {
        try {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch {
          // The process may have exited between the check and signal.
        }
        escalation ??= setTimeout(() => {
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // The process tree has exited.
          }
        }, 2_000);
        escalation.unref();
      }
    };
    let output: Buffer = Buffer.alloc(0);
    let errorOutput: Buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let totalNewlines = 0;
    let overflowed = false;
    let timedOut = false;
    let settled = false;

    const retain = (current: Buffer, chunk: Buffer, tail: boolean, limit: number) => {
      if (tail) {
        const combined = Buffer.concat([current, chunk]);
        return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
      }
      if (current.length >= limit) return current;
      return Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
    };
    child.stdout.on('data', (value: Buffer) => {
      totalBytes += value.length;
      for (const byte of value) if (byte === 10) totalNewlines += 1;
      output = retain(output, value, keepTail, maxBytes);
      if (rejectOverflow && totalBytes > maxBytes && !overflowed) {
        overflowed = true;
        terminate();
      }
    });
    child.stderr.on('data', (value: Buffer) => {
      errorOutput = retain(errorOutput, value, true, MAX_OUTPUT_BYTES);
    });
    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    child.on('error', finishWithError);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeout);
    timer.unref();
    const abort = terminate;
    signal?.addEventListener('abort', abort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (settled) return;
      if (signal?.aborted) return finishWithError(new Error(`${command} was cancelled`));
      if (timedOut) return finishWithError(new Error(`${command} timed out after ${timeout} ms`));
      if (overflowed)
        return finishWithError(
          new Error('GitHub API response exceeded the 1,000,000-byte request limit'),
        );
      if (code !== 0) {
        const failure = bounded(
          errorOutput.toString('utf8') ||
            output.toString('utf8') ||
            `${command} exited with status ${code}`,
          true,
        );
        return finishWithError(
          new Error(failure.text + (failure.truncated ? '\n[Error output truncated]' : '')),
        );
      }
      const retained = bounded(decodeUtf8(output, keepTail), keepTail, maxBytes, maxLines);
      settled = true;
      resolvePromise({
        ...retained,
        truncated:
          retained.truncated ||
          totalBytes > retained.returned_bytes ||
          totalNewlines + 1 > retained.returned_lines,
        total_bytes: totalBytes,
        total_lines: totalNewlines + 1,
        keep_tail: keepTail,
      });
    });
  });
}

export async function execRaw(command: string, args: string[], signal?: AbortSignal) {
  return (
    await execStreaming(command, args, signal, false, MAX_API_BYTES, Number.MAX_SAFE_INTEGER, true)
  ).text;
}

export async function exec(
  command: string,
  args: string[],
  signal?: AbortSignal,
  keepTail = false,
) {
  return await execStreaming(command, args, signal, keepTail);
}
