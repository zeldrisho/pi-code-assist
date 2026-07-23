import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';
import { runProcess } from '../scripts/process.ts';

let root: string;
const environment = { ...process.env };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-process-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const options = (input?: string) => ({
  cwd: process.cwd(),
  env: environment,
  input,
  timeoutMs: 5_000,
});

describe('generic process lifecycle', () => {
  test('writes stdin and returns a successful exit', async () => {
    const chunks: Buffer[] = [];
    const result = await runProcess(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { ...options('prompt only on stdin'), onStdout: (chunk) => chunks.push(chunk) },
    );
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false });
    expect(Buffer.concat(chunks).toString()).toBe('prompt only on stdin');
  });

  test('returns nonzero and signal exits without applying caller policy', async () => {
    expect(await runProcess(process.execPath, ['-e', 'process.exit(23)'], options())).toMatchObject(
      {
        code: 23,
        signal: null,
        timedOut: false,
      },
    );
    const signalled = await runProcess(
      process.execPath,
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      options(),
    );
    expect(signalled.code).toBeNull();
    expect(signalled.signal).toBe('SIGTERM');
  });

  test('reports spawn failure as structured exit information', async () => {
    const result = await runProcess(join(root, 'missing-command'), [], options());
    expect(result.code).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
  });

  test('times out and terminates the full process tree', async () => {
    const marker = join(root, 'child-terminated');
    const source = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'terminated'); process.exit(0); }); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
setInterval(() => {}, 1000);
`;
    const result = await runProcess(process.execPath, ['-e', source], {
      cwd: process.cwd(),
      env: environment,
      timeoutMs: 250,
    });
    expect(result.timedOut).toBe(true);
    expect(await readFile(marker, 'utf8')).toBe('terminated');
  });

  test('escalates from SIGTERM to SIGKILL when a process does not exit', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), env: environment, timeoutMs: 100 },
    );
    expect(result).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: true });
  });
});
