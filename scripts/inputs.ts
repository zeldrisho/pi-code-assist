import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setSecret } from '@actions/core';

const SEMVER = /^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const NPM_PACKAGE =
  /^npm:(?:(?:@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)|(?:[A-Za-z0-9_.-]+))@\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/;
const GIT_PACKAGE = /^git:\S+@[0-9a-fA-F]{40}$/;
const THINKING_LEVELS = new Set(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const GITHUB_TOOL_MODES = new Set(['none', 'read', 'write']);

export type GitHubToolsMode = 'none' | 'read' | 'write';

export interface ActionConfig {
  readonly workspace: string;
  readonly workingDirectory: string;
  readonly runnerTemp: string;
  readonly githubOutput: string;
  readonly actionPath: string;
  readonly githubExtensionPath: string;
  readonly githubRepository?: string;
  readonly githubTools: GitHubToolsMode;
  readonly githubToken?: string;
  readonly prompt: string;
  readonly apiKey: string;
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly thinking: string;
  readonly selectedTools: string;
  readonly projectTrust: boolean;
  readonly packageSources: readonly string[];
  readonly installTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly runId: string;
  readonly runAttempt: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function required(env: NodeJS.ProcessEnv, name: string, message: string): string {
  const value = env[name];
  if (!value) fail(message);
  return value;
}

export function maskInputSecrets(env: NodeJS.ProcessEnv): void {
  if (env.PI_AGENT_INPUT_API_KEY) setSecret(env.PI_AGENT_INPUT_API_KEY);
  if (env.PI_AGENT_GITHUB_TOKEN) setSecret(env.PI_AGENT_GITHUB_TOKEN);
}

function timeoutMilliseconds(
  env: NodeJS.ProcessEnv,
  name: string,
  label: string,
  fallback: string,
): number {
  const value = env[name] || fallback;
  if (!POSITIVE_INTEGER.test(value)) fail(`${label} must be a positive integer number of seconds`);
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > 86_400)
    fail(`${label} must be no greater than 86400 seconds`);
  return seconds * 1_000;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    fail(`${label} does not exist: ${path}`);
  }
  if (!(await stat(canonical)).isDirectory()) fail(`${label} must be a directory`);
  return canonical;
}

async function resolveInside(root: string, requested: string, label: string): Promise<string> {
  if (isAbsolute(requested)) fail(`${label} must be relative to GITHUB_WORKSPACE`);
  let candidate: string;
  try {
    candidate = await realpath(resolve(root, requested));
  } catch {
    fail(`${label} does not exist: ${requested}`);
  }
  if (!inside(root, candidate)) fail(`${label} must stay within GITHUB_WORKSPACE`);
  return candidate;
}

export async function parseActionConfig(
  env: NodeJS.ProcessEnv,
  secretsAlreadyMasked = false,
): Promise<ActionConfig> {
  if (!secretsAlreadyMasked) maskInputSecrets(env);
  const apiKey = required(env, 'PI_AGENT_INPUT_API_KEY', 'api-key is required');

  const workspaceInput = required(env, 'GITHUB_WORKSPACE', 'GITHUB_WORKSPACE is not set');
  const runnerTempInput = required(env, 'RUNNER_TEMP', 'RUNNER_TEMP is not set');
  const githubOutput = required(env, 'GITHUB_OUTPUT', 'GITHUB_OUTPUT is not set');
  const actionPathInput = required(env, 'GITHUB_ACTION_PATH', 'GITHUB_ACTION_PATH is not set');
  const prompt = required(env, 'PI_AGENT_INPUT_PROMPT', 'prompt is required');
  const provider = required(env, 'PI_AGENT_INPUT_PROVIDER', 'provider is required');
  const model = required(env, 'PI_AGENT_INPUT_MODEL', 'model is required');
  const version = required(env, 'PI_AGENT_INPUT_VERSION', 'pi-version is required');
  if (!SEMVER.test(version)) fail('pi-version must be an exact semantic version');

  const thinking = env.PI_AGENT_INPUT_THINKING || '';
  if (!THINKING_LEVELS.has(thinking)) fail(`unsupported thinking level: ${thinking}`);
  const projectTrust = env.PI_AGENT_INPUT_PROJECT_TRUST || 'false';
  if (projectTrust !== 'true' && projectTrust !== 'false')
    fail('project-trust must be true or false');
  const githubTools = env.PI_AGENT_INPUT_GITHUB_TOOLS || 'none';
  if (!GITHUB_TOOL_MODES.has(githubTools)) fail('github-tools must be none, read, or write');

  const workspace = await canonicalDirectory(workspaceInput, 'GITHUB_WORKSPACE');
  const runnerTemp = await canonicalDirectory(runnerTempInput, 'RUNNER_TEMP');
  const actionPath = await canonicalDirectory(actionPathInput, 'GITHUB_ACTION_PATH');
  const workingDirectory = await resolveInside(
    workspace,
    env.PI_AGENT_INPUT_WORKING_DIRECTORY || '.',
    'working-directory',
  );
  if (!(await stat(workingDirectory)).isDirectory()) fail('working-directory must be a directory');

  let githubRepository: string | undefined;
  let githubToken: string | undefined;
  const githubExtensionPath = join(actionPath, 'extensions', 'github', 'index.ts');
  if (githubTools !== 'none') {
    githubToken = env.PI_AGENT_GITHUB_TOKEN;
    if (!githubToken) fail('GitHub Actions token is unavailable while github-tools is enabled');
    githubRepository = env.GITHUB_REPOSITORY;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository || ''))
      fail('GITHUB_REPOSITORY must identify an owner/repository');
    await access(githubExtensionPath).catch(() => fail('bundled GitHub extension is missing'));
  }

  const packageSources: string[] = [];
  for (const rawSource of (env.PI_AGENT_INPUT_PACKAGES || '').split('\n')) {
    const source = rawSource.replace(/\r$/, '');
    if (!source) continue;
    if (NPM_PACKAGE.test(source) || GIT_PACKAGE.test(source)) packageSources.push(source);
    else if (source.startsWith('./'))
      packageSources.push(await resolveInside(workspace, source, 'package path'));
    else
      fail(
        `package must be an exact-pinned npm/git source or a workspace-relative path: ${source}`,
      );
  }

  return Object.freeze({
    workspace,
    workingDirectory,
    runnerTemp,
    githubOutput,
    actionPath,
    githubExtensionPath,
    ...(githubRepository ? { githubRepository } : {}),
    githubTools: githubTools as GitHubToolsMode,
    ...(githubToken ? { githubToken } : {}),
    prompt,
    apiKey,
    provider,
    model,
    version,
    thinking,
    selectedTools: env.PI_AGENT_INPUT_TOOLS || '',
    projectTrust: projectTrust === 'true',
    packageSources: Object.freeze(packageSources),
    installTimeoutMs: timeoutMilliseconds(
      env,
      'PI_AGENT_INPUT_INSTALL_TIMEOUT',
      'install-timeout',
      '300',
    ),
    executionTimeoutMs: timeoutMilliseconds(
      env,
      'PI_AGENT_INPUT_EXECUTION_TIMEOUT',
      'execution-timeout',
      '600',
    ),
    runId: env.GITHUB_RUN_ID || 'local',
    runAttempt: env.GITHUB_RUN_ATTEMPT || '1',
  });
}
