import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { runAction } from '../scripts/run.ts';

let root: string;
let workspace: string;
let runner: string;
let output: string;
let actionPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-code-assist-timeout-'));
  workspace = join(root, 'workspace');
  runner = join(root, 'runner');
  output = join(root, 'output');
  actionPath = await realpath('.');
  await mkdir(workspace);
  await mkdir(runner);
  await writeFile(output, '');
});

afterEach(async () => {
  delete process.env.PI_AGENT_TEST_HANG;
  delete process.env.PI_AGENT_TEST_TERMINATED;
  await rm(root, { recursive: true, force: true });
});

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTION_PATH: actionPath,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runner,
    GITHUB_OUTPUT: output,
    PI_AGENT_INPUT_PROMPT: 'timeout test',
    PI_AGENT_INPUT_API_KEY: 'test-api-key',
    PI_AGENT_INPUT_PROVIDER: 'opencode',
    PI_AGENT_INPUT_MODEL: 'test-model',
    PI_AGENT_INPUT_VERSION: '0.80.10',
    ...overrides,
  };
}

describe('phase timeouts', () => {
  test('terminates the Pi process tree when model execution times out', async () => {
    const marker = join(root, 'execution-terminated');
    process.env.PI_AGENT_TEST_HANG = 'true';
    process.env.PI_AGENT_TEST_TERMINATED = marker;

    await expect(
      runAction(
        environment({
          PI_AGENT_INPUT_EXECUTION_TIMEOUT: '1',
          PI_AGENT_TEST_BIN: join(actionPath, 'node_modules', '.bin', 'tsx'),
          PI_AGENT_TEST_SCRIPT: join(actionPath, 'tests', 'fake-pi.ts'),
        }),
      ),
    ).rejects.toThrow('Pi/model invocation timed out after 1 second');
    expect(await readFile(marker, 'utf8')).toBe('SIGTERM\n');
  });

  test('terminates Vite+ when Pi installation times out', async () => {
    const bin = join(root, 'bin');
    const marker = join(root, 'installation-terminated');
    const fakeVp = join(bin, 'vp');
    await mkdir(bin);
    await writeFile(
      fakeVp,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(marker)}, 'SIGTERM\\n');
  process.exit(0);
});
setInterval(() => {}, 60000);
`,
    );
    await chmod(fakeVp, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath || ''}`;
    try {
      await expect(runAction(environment({ PI_AGENT_INPUT_INSTALL_TIMEOUT: '1' }))).rejects.toThrow(
        'Pi installation timed out after 1 second',
      );
      expect(await readFile(marker, 'utf8')).toBe('SIGTERM\n');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
