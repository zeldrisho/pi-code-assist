import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { runAction } from '../scripts/run.ts';

test('installs and probes the configured Pi release through Vite+', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-assist-install-'));
  const workspace = join(root, 'workspace');
  const runner = join(root, 'runner');
  const output = join(root, 'output');
  await mkdir(workspace);
  await mkdir(runner);
  await writeFile(output, '');
  try {
    await runAction({
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runner,
      GITHUB_OUTPUT: output,
      PI_AGENT_INPUT_PROMPT: 'installation-probe',
      PI_AGENT_INPUT_API_KEY: 'installation-probe',
      PI_AGENT_INPUT_PROVIDER: 'opencode',
      PI_AGENT_INPUT_MODEL: 'installation-probe',
      PI_AGENT_INPUT_VERSION: '0.80.10',
      PI_AGENT_TEST_INSTALL_ONLY: 'true',
    });
    expect(true).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
