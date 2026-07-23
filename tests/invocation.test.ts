import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test';
import { GITHUB_READ_TOOLS, GITHUB_WRITE_TOOLS } from '../extensions/github/manifest.ts';
import type { InstalledPi } from '../scripts/installation.ts';
import type { ActionConfig } from '../scripts/inputs.ts';
import {
  buildChildEnvironment,
  buildPiArguments,
  createInvocation,
  invokePi,
} from '../scripts/invocation.ts';

let root: string;
let config: ActionConfig;
const installed: InstalledPi = {
  executable: '/fake/pi',
  version: '1.2.3',
  installationRoot: '/fake/root',
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-invocation-'));
  await mkdir(join(root, 'workspace'));
  config = Object.freeze({
    workspace: join(root, 'workspace'),
    workingDirectory: join(root, 'workspace'),
    runnerTemp: root,
    githubOutput: join(root, 'output'),
    actionPath: '/action',
    githubExtensionPath: '/action/extensions/github/index.ts',
    githubRepository: 'example/repository',
    githubTools: 'write',
    githubToken: 'github-secret',
    prompt: '-prompt; never execute',
    apiKey: 'api-secret',
    provider: 'provider',
    model: 'model',
    version: '1.2.3',
    thinking: 'high',
    selectedTools: 'read,grep',
    projectTrust: false,
    packageSources: Object.freeze(['/package']),
    installTimeoutMs: 1_000,
    executionTimeoutMs: 2_000,
    runId: '1',
    runAttempt: '2',
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Pi invocation', () => {
  test('derives arguments and tools from the shared manifest', () => {
    const args = buildPiArguments(config);
    expect(args).toContain(config.githubExtensionPath);
    expect(args).not.toContain(config.prompt);
    expect(args).toContain(config.apiKey);
    expect(args).toContain(`read,grep,${[...GITHUB_READ_TOOLS, ...GITHUB_WRITE_TOOLS].join(',')}`);
    expect(args).toContain('--no-approve');
  });

  test('constructs a fresh explicit child environment without mutating its source', () => {
    const source = {
      KEEP: 'yes',
      GH_TOKEN: 'old',
      PI_AGENT_INPUT_API_KEY: 'api-secret',
      PI_AGENT_INPUT_PROMPT: 'prompt',
      PI_AGENT_GITHUB_TOKEN: 'github-secret',
    };
    const child = buildChildEnvironment(source, config);
    expect(child).not.toBe(source);
    expect(source).toHaveProperty('PI_AGENT_GITHUB_TOKEN');
    expect(child).toMatchObject({
      KEEP: 'yes',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      PI_AGENT_GITHUB_TOOLS: 'write',
      GH_TOKEN: 'github-secret',
    });
    expect(child.PI_AGENT_INPUT_API_KEY).toBeUndefined();
    expect(child.PI_AGENT_INPUT_PROMPT).toBeUndefined();
    expect(child.PI_AGENT_GITHUB_TOKEN).toBeUndefined();
    const disabled = buildChildEnvironment(source, { githubTools: 'none' });
    expect(disabled.GH_TOKEN).toBeUndefined();
  });

  test('passes the prompt through stdin and streams stdout to file and job log', async () => {
    let observed: ReturnType<typeof createInvocation> | undefined;
    const writes: Buffer[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const result = await invokePi(
        config,
        installed,
        { SOURCE: 'yes' },
        async (command, args, options) => {
          observed = {
            command,
            args,
            cwd: options.cwd,
            prompt: options.input || '',
            responseFile: '',
            timeoutMs: options.timeoutMs,
            env: options.env,
          };
          options.onStdout?.(Buffer.from('streamed response\n'));
          return { code: 17, signal: null, timedOut: false };
        },
      );
      expect(result.status).toBe(17);
      expect(observed?.prompt).toBe(config.prompt);
      expect(observed?.args).not.toContain(config.prompt);
      expect(await readFile(result.responseFile, 'utf8')).toBe('streamed response\n');
      expect(Buffer.concat(writes).toString()).toContain('streamed response');
    } finally {
      stdout.mockRestore();
    }
  });
});
