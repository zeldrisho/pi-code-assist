import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';
import { type Execution, runAction } from '../scripts/run.ts';

let root: string;
let workspace: string;
let runner: string;
let output: string;
let baseEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-code-assist-runtime-'));
  workspace = join(root, 'workspace');
  runner = join(root, 'runner');
  output = join(root, 'output');
  await mkdir(join(workspace, 'project'), { recursive: true });
  await mkdir(join(workspace, 'pi-package'));
  await mkdir(runner);
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(workspace, 'project', 'outside-link'));
  baseEnv = {
    GITHUB_ACTION_PATH: await realpath('.'),
    GITHUB_REPOSITORY: 'example/repository',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runner,
    GITHUB_OUTPUT: output,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    PI_AGENT_INPUT_PROMPT: '-Review this; echo NOT_EXECUTED\nthen summarize',
    PI_AGENT_INPUT_API_KEY: 'test-api-key',
    PI_AGENT_INPUT_PROVIDER: 'opencode',
    PI_AGENT_INPUT_MODEL: 'test-model',
    PI_AGENT_INPUT_THINKING: 'medium',
    PI_AGENT_INPUT_TOOLS: 'read,grep',
    PI_AGENT_INPUT_PROJECT_TRUST: 'false',
    PI_AGENT_INPUT_PACKAGES: '',
    PI_AGENT_INPUT_GITHUB_TOOLS: 'none',
    PI_AGENT_INPUT_VERSION: '0.80.10',
    PI_AGENT_INPUT_WORKING_DIRECTORY: 'project',
    PI_AGENT_TEST_BIN: '/fake/pi',
  };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function invoke(
  overrides: NodeJS.ProcessEnv = {},
  result = 'review complete\nsecond line\n',
  status = 0,
) {
  await writeFile(output, '');
  let execution: Execution | undefined;
  await runAction(
    { ...baseEnv, ...overrides },
    {
      execute: async (value) => {
        execution = value;
        await writeFile(value.responseFile, result, { mode: 0o600 });
        return status;
      },
    },
  );
  return { execution: execution!, outputs: await readFile(output, 'utf8') };
}

function hasPair(args: string[], flag: string, value: string): boolean {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] === value;
}

describe('action runtime', () => {
  test('passes validated options while keeping the prompt on standard input', async () => {
    const { execution, outputs } = await invoke();
    expect(execution.prompt).toBe(baseEnv.PI_AGENT_INPUT_PROMPT);
    expect(execution.args).toContain('--print');
    expect(execution.args).toContain('--no-session');
    expect(execution.args).toContain('--no-approve');
    expect(hasPair(execution.args, '--thinking', 'medium')).toBe(true);
    expect(hasPair(execution.args, '--tools', 'read,grep')).toBe(true);
    expect(execution.args).not.toContain(baseEnv.PI_AGENT_INPUT_PROMPT);
    expect(outputs).toMatch(/^response-path=/m);
    expect(outputs).toMatch(/^response<</m);
    expect(outputs).toContain('review complete');
  });

  test.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'supports thinking=%s',
    async (thinking) => {
      const { execution } = await invoke({ PI_AGENT_INPUT_THINKING: thinking });
      expect(hasPair(execution.args, '--thinking', thinking)).toBe(true);
    },
  );

  test('leaves Pi thinking and tools defaults untouched when omitted or all', async () => {
    let result = await invoke({ PI_AGENT_INPUT_THINKING: '' });
    expect(result.execution.args).not.toContain('--thinking');
    result = await invoke({ PI_AGENT_INPUT_TOOLS: 'all' });
    expect(result.execution.args).not.toContain('--tools');
  });

  test.each([
    ['PI_AGENT_INPUT_API_KEY', '', 'api-key is required'],
    ['PI_AGENT_INPUT_PROVIDER', '', 'provider is required'],
    ['PI_AGENT_INPUT_MODEL', '', 'model is required'],
    ['PI_AGENT_INPUT_THINKING', 'extreme', 'unsupported thinking level'],
    ['PI_AGENT_INPUT_PROJECT_TRUST', 'maybe', 'project-trust must be true or false'],
    ['PI_AGENT_INPUT_VERSION', '', 'pi-version is required'],
    ['PI_AGENT_INPUT_VERSION', 'latest', 'exact semantic version'],
    ['PI_AGENT_INPUT_GITHUB_TOOLS', 'admin', 'github-tools must be none, read, or write'],
  ])('rejects invalid %s', async (key, value, message) => {
    await expect(invoke({ [key]: value })).rejects.toThrow(message);
  });

  test('requires a token and valid repository for GitHub tools', async () => {
    await expect(invoke({ PI_AGENT_INPUT_GITHUB_TOOLS: 'read' })).rejects.toThrow(
      'token is unavailable',
    );
    await expect(
      invoke({
        PI_AGENT_INPUT_GITHUB_TOOLS: 'read',
        PI_AGENT_GITHUB_TOKEN: 'secret',
        GITHUB_REPOSITORY: 'invalid',
      }),
    ).rejects.toThrow('owner/repository');
  });

  test('enables trusted projects and selected GitHub tools', async () => {
    let result = await invoke({ PI_AGENT_INPUT_PROJECT_TRUST: 'true' });
    expect(result.execution.args).toContain('--approve');
    result = await invoke({ PI_AGENT_INPUT_GITHUB_TOOLS: 'read', PI_AGENT_GITHUB_TOKEN: 'secret' });
    expect(result.execution.args).toContain(
      join(baseEnv.GITHUB_ACTION_PATH!, 'extensions', 'github-tools.ts'),
    );
    expect(result.execution.args).toContain(
      'read,grep,get_issue_or_pr_thread,get_pr_diff,get_ci_status,get_workflow_run_logs',
    );
    result = await invoke({
      PI_AGENT_INPUT_GITHUB_TOOLS: 'write',
      PI_AGENT_GITHUB_TOKEN: 'secret',
    });
    expect(result.execution.args.join(',')).toContain('create_pull_request');
  });

  test('accepts immutable packages and resolves local paths', async () => {
    const packages = [
      'npm:example-pi-package@1.2.3',
      'git:github.com/example/pi-package@0123456789abcdef0123456789abcdef01234567',
      './pi-package',
    ].join('\n');
    const { execution } = await invoke({ PI_AGENT_INPUT_PACKAGES: packages });
    expect(execution.args).toContain('npm:example-pi-package@1.2.3');
    expect(execution.args).toContain(await realpath(join(workspace, 'pi-package')));
  });

  test.each([
    'npm:example-pi-package@latest',
    'npm:@invalid-scope@1.2.3',
    'git:github.com/example/pi-package@main',
    './project/outside-link',
  ])('rejects unsafe package source %s', async (source) => {
    await expect(invoke({ PI_AGENT_INPUT_PACKAGES: source })).rejects.toThrow(/package/);
  });

  test('preserves failures after publishing the partial response path', async () => {
    await expect(invoke({}, 'partial response\n', 23)).rejects.toThrow('Pi exited with status 23');
    expect(await readFile(output, 'utf8')).toMatch(/^response-path=/m);
  });

  test('enforces the response output byte boundary', async () => {
    await expect(invoke({}, 'x'.repeat(400_000))).resolves.toBeDefined();
    await expect(invoke({}, '😀'.repeat(100_000))).resolves.toBeDefined();
    await expect(invoke({}, 'x'.repeat(400_001))).rejects.toThrow('use response-path instead');
    expect(await readFile(output, 'utf8')).toMatch(/^response-path=/m);
  });

  test.each(['..', 'project/outside-link', 'missing', '/tmp'])(
    'rejects unsafe working directory %s',
    async (directory) => {
      await expect(invoke({ PI_AGENT_INPUT_WORKING_DIRECTORY: directory })).rejects.toThrow(
        /working-directory/,
      );
    },
  );

  test('probes an installed Pi version', async () => {
    const result = await invoke({ PI_AGENT_TEST_INSTALL_ONLY: 'true' }, '0.80.10\n');
    expect(result.execution.args).toEqual(['--version']);
  });
});
