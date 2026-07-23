import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';
import { parseActionConfig } from '../scripts/inputs.ts';

let root: string;
let workspace: string;
let runner: string;
let actionPath: string;
let baseEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-inputs-'));
  workspace = join(root, 'workspace');
  runner = join(root, 'runner');
  actionPath = await realpath('.');
  await mkdir(join(workspace, 'project'), { recursive: true });
  await mkdir(join(workspace, 'package'));
  await writeFile(join(workspace, 'file'), 'not a directory');
  await mkdir(runner);
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(workspace, 'escape'));
  await writeFile(join(root, 'output'), '');
  baseEnv = {
    GITHUB_ACTION_PATH: actionPath,
    GITHUB_REPOSITORY: 'example/repository',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runner,
    GITHUB_OUTPUT: join(root, 'output'),
    PI_AGENT_INPUT_PROMPT: 'review',
    PI_AGENT_INPUT_API_KEY: 'api-secret',
    PI_AGENT_INPUT_PROVIDER: 'opencode',
    PI_AGENT_INPUT_MODEL: 'model',
    PI_AGENT_INPUT_VERSION: '0.80.10',
    PI_AGENT_INPUT_WORKING_DIRECTORY: 'project',
  };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function parse(overrides: NodeJS.ProcessEnv = {}) {
  return parseActionConfig({ ...baseEnv, ...overrides });
}

describe('action inputs', () => {
  test('returns canonical immutable configuration after full validation', async () => {
    const config = await parse({
      PI_AGENT_INPUT_PACKAGES:
        'npm:example@1.2.3\ngit:github.com/example/pkg@0123456789abcdef0123456789abcdef01234567\n./package',
      PI_AGENT_INPUT_GITHUB_TOOLS: 'read',
      PI_AGENT_GITHUB_TOKEN: 'github-secret',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.packageSources)).toBe(true);
    expect(config.workspace).toBe(await realpath(workspace));
    expect(config.workingDirectory).toBe(await realpath(join(workspace, 'project')));
    expect(config.packageSources.at(-1)).toBe(await realpath(join(workspace, 'package')));
    expect(config.installTimeoutMs).toBe(300_000);
  });

  test.each([
    ['PI_AGENT_INPUT_PROMPT', '', 'prompt is required'],
    ['PI_AGENT_INPUT_API_KEY', '', 'api-key is required'],
    ['PI_AGENT_INPUT_PROVIDER', '', 'provider is required'],
    ['PI_AGENT_INPUT_MODEL', '', 'model is required'],
    ['PI_AGENT_INPUT_VERSION', 'latest', 'exact semantic version'],
    ['PI_AGENT_INPUT_THINKING', 'extreme', 'unsupported thinking level'],
    ['PI_AGENT_INPUT_PROJECT_TRUST', 'maybe', 'project-trust must be true or false'],
    ['PI_AGENT_INPUT_GITHUB_TOOLS', 'admin', 'github-tools must be none, read, or write'],
    ['PI_AGENT_INPUT_INSTALL_TIMEOUT', '0', 'positive integer'],
    ['PI_AGENT_INPUT_EXECUTION_TIMEOUT', '86401', 'no greater than 86400'],
  ])('rejects invalid %s', async (name, value, message) => {
    await expect(parse({ [name]: value })).rejects.toThrow(message);
  });

  test('validates GitHub prerequisites', async () => {
    await expect(parse({ PI_AGENT_INPUT_GITHUB_TOOLS: 'read' })).rejects.toThrow(
      'token is unavailable',
    );
    await expect(
      parse({
        PI_AGENT_INPUT_GITHUB_TOOLS: 'read',
        PI_AGENT_GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'invalid',
      }),
    ).rejects.toThrow('owner/repository');
  });

  test.each(['..', 'escape', 'missing', 'file', '/tmp'])(
    'rejects working-directory boundary violation %s',
    async (value) => {
      await expect(parse({ PI_AGENT_INPUT_WORKING_DIRECTORY: value })).rejects.toThrow(
        /working-directory/,
      );
    },
  );

  test.each([
    'npm:example@latest',
    'git:github.com/example/pkg@main',
    '../package',
    './escape',
    './missing',
  ])('rejects unsafe package source %s', async (value) => {
    await expect(parse({ PI_AGENT_INPUT_PACKAGES: value })).rejects.toThrow(/package/);
  });
});
