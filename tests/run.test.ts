import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import type { InstalledPi } from '../scripts/installation.ts';
import type { ActionConfig } from '../scripts/inputs.ts';
import { runAction } from '../scripts/run.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-run-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test('orchestrates validation, installation, invocation, publication, and status policy in order', async () => {
  const events: string[] = [];
  const responseFile = join(root, 'response');
  await writeFile(responseFile, 'partial response\n');
  const config = {
    githubOutput: join(root, 'output'),
    provider: 'provider',
    model: 'model',
  } as ActionConfig;
  const installed = {
    executable: '/pi',
    version: '1.2.3',
    installationRoot: '/install',
  } as InstalledPi;

  await expect(
    runAction(
      { PI_AGENT_INPUT_API_KEY: 'masked-first' },
      {
        parse: async () => {
          events.push('parse');
          return config;
        },
        install: async (received) => {
          expect(received).toBe(config);
          events.push('install');
          return installed;
        },
        invoke: async (receivedConfig, receivedInstallation) => {
          expect(receivedConfig).toBe(config);
          expect(receivedInstallation).toBe(installed);
          events.push('invoke');
          return { status: 23, responseFile };
        },
        publish: async (_output, receivedPath) => {
          expect(receivedPath).toBe(responseFile);
          events.push('publish');
          return { empty: false, responsePath: responseFile };
        },
      },
    ),
  ).rejects.toThrow('Pi exited with status 23');
  expect(events).toEqual(['parse', 'install', 'invoke', 'publish']);
});
