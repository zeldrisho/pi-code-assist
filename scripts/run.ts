import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RESPONSE_OUTPUT_MAX_BYTES = 400_000;
const SEMVER = /^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/;
const NPM_PACKAGE =
  /^npm:(?:(?:@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)|(?:[A-Za-z0-9_.-]+))@\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/;
const GIT_PACKAGE = /^git:\S+@[0-9a-fA-F]{40}$/;
const THINKING_LEVELS = new Set(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const GITHUB_TOOL_MODES = new Set(['none', 'read', 'write']);

export interface Execution {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  responseFile: string;
}

export interface RuntimeHooks {
  execute?: (execution: Execution) => Promise<number>;
  install?: (installRoot: string, version: string) => Promise<string>;
}

function fail(message: string): never {
  throw new Error(message);
}

function required(env: NodeJS.ProcessEnv, name: string, message: string): string {
  const value = env[name];
  if (!value) fail(message);
  return value;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
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

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; input?: string },
): Promise<number> {
  return await new Promise((resolveStatus, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`${command} was terminated by ${signal}`));
      else resolveStatus(code ?? 1);
    });
    child.stdin.end(options.input);
  });
}

async function installPi(installRoot: string, version: string): Promise<string> {
  const executable = join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'pi.cmd' : 'pi',
  );
  try {
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    await mkdir(installRoot, { recursive: true });
    await writeFile(
      join(installRoot, 'package.json'),
      `${JSON.stringify(
        {
          private: true,
          dependencies: { '@earendil-works/pi-coding-agent': version },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Installing Pi ${version} through Vite+...`);
    const status = await runProcess(
      'vp',
      ['install', '--ignore-scripts', '--no-lockfile', '--silent'],
      { cwd: installRoot },
    );
    if (status !== 0) fail(`Pi installation failed with status ${status}`);
    await access(executable, constants.X_OK).catch(() =>
      fail(`Pi executable not found: ${executable}`),
    );
    return executable;
  }
}

async function executePi({ command, args, cwd, prompt, responseFile }: Execution): Promise<number> {
  return await new Promise((resolveStatus, reject) => {
    const output = createWriteStream(responseFile, { flags: 'wx', mode: 0o600 });
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let exitStatus: number | undefined;
    let outputFinished = false;
    const complete = () => {
      if (exitStatus !== undefined && outputFinished) resolveStatus(exitStatus);
    };
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.stdout.once('error', reject);
    output.once('error', reject);
    output.once('finish', () => {
      outputFinished = true;
      complete();
    });
    child.stdout.pipe(output);
    child.stdout.pipe(process.stdout, { end: false });
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Pi was terminated by ${signal}`));
      else {
        exitStatus = code ?? 1;
        complete();
      }
    });
    child.stdin.end(prompt);
  });
}

export async function runAction(
  env: NodeJS.ProcessEnv = process.env,
  hooks: RuntimeHooks = {},
): Promise<void> {
  const workspaceInput = required(env, 'GITHUB_WORKSPACE', 'GITHUB_WORKSPACE is not set');
  const runnerTemp = required(env, 'RUNNER_TEMP', 'RUNNER_TEMP is not set');
  const githubOutput = required(env, 'GITHUB_OUTPUT', 'GITHUB_OUTPUT is not set');
  const prompt = required(env, 'PI_AGENT_INPUT_PROMPT', 'prompt is required');
  const apiKey = required(env, 'PI_AGENT_INPUT_API_KEY', 'api-key is required');
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
  if (githubTools !== 'none') {
    if (!env.PI_AGENT_GITHUB_TOKEN)
      fail('GitHub Actions token is unavailable while github-tools is enabled');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')) {
      fail('GITHUB_REPOSITORY must identify an owner/repository');
    }
    const actionPath = required(env, 'GITHUB_ACTION_PATH', 'GITHUB_ACTION_PATH is not set');
    await access(join(actionPath, 'extensions', 'github-tools.ts')).catch(() =>
      fail('bundled GitHub extension is missing'),
    );
  }

  const workspace = await realpath(workspaceInput);
  const workingDirectory = await resolveInside(
    workspace,
    env.PI_AGENT_INPUT_WORKING_DIRECTORY || '.',
    'working-directory',
  );
  if (!(await stat(workingDirectory)).isDirectory()) fail('working-directory must be a directory');

  const packageSources: string[] = [];
  for (const rawSource of (env.PI_AGENT_INPUT_PACKAGES || '').split('\n')) {
    const source = rawSource.replace(/\r$/, '');
    if (!source) continue;
    if (NPM_PACKAGE.test(source) || GIT_PACKAGE.test(source)) packageSources.push(source);
    else if (source.startsWith('./')) {
      const packagePath = await resolveInside(workspace, source, 'package path');
      packageSources.push(packagePath);
    } else
      fail(
        `package must be an exact-pinned npm/git source or a workspace-relative path: ${source}`,
      );
  }

  console.log(`::add-mask::${apiKey}`);
  if (env.PI_AGENT_GITHUB_TOKEN) console.log(`::add-mask::${env.PI_AGENT_GITHUB_TOKEN}`);

  const installRoot = join(runnerTemp, `pi-agent-${version}`);
  const piExecutable =
    env.PI_AGENT_TEST_BIN || (await (hooks.install || installPi)(installRoot, version));
  const commandPrefix = env.PI_AGENT_TEST_SCRIPT ? [env.PI_AGENT_TEST_SCRIPT] : [];
  const args = ['--print', '--no-session'];
  if (thinking) args.push('--thinking', thinking);
  args.push(
    projectTrust === 'true' ? '--approve' : '--no-approve',
    '--provider',
    provider,
    '--model',
    model,
    '--api-key',
    apiKey,
  );
  for (const source of packageSources) args.push('--extension', source);

  let selectedTools = env.PI_AGENT_INPUT_TOOLS || '';
  if (githubTools !== 'none') {
    args.push('--extension', join(env.GITHUB_ACTION_PATH!, 'extensions', 'github-tools.ts'));
    let names = 'get_issue_or_pr_thread,get_pr_diff,get_ci_status,get_workflow_run_logs';
    if (githubTools === 'write')
      names += ',post_comment,create_pull_request_review,create_pull_request,update_pull_request';
    if (selectedTools && selectedTools !== 'all') selectedTools += `,${names}`;
  }
  if (selectedTools && selectedTools !== 'all') args.push('--tools', selectedTools);

  process.env.PI_SKIP_VERSION_CHECK = '1';
  process.env.PI_TELEMETRY = '0';
  process.env.PI_AGENT_GITHUB_TOOLS = githubTools;
  if (githubTools !== 'none') {
    process.env.GH_TOKEN = env.PI_AGENT_GITHUB_TOKEN;
    delete process.env.PI_AGENT_GITHUB_TOKEN;
  }

  if (env.PI_AGENT_TEST_INSTALL_ONLY === 'true') {
    const probeFile = join(runnerTemp, `pi-agent-version-${randomUUID()}.txt`);
    const status = await (hooks.execute || executePi)({
      command: piExecutable,
      args: [...commandPrefix, '--version'],
      cwd: workingDirectory,
      prompt: '',
      responseFile: probeFile,
    });
    if (status !== 0) fail('Pi version probe failed');
    const installedVersion = (await readFile(probeFile, 'utf8')).trim();
    if (installedVersion !== version)
      fail(`installed Pi version mismatch: expected ${version}, received ${installedVersion}`);
    console.log(`Pi ${installedVersion} installation verified.`);
    return;
  }

  const responseFile = join(
    runnerTemp,
    `pi-agent-response-${env.GITHUB_RUN_ID || 'local'}-${env.GITHUB_RUN_ATTEMPT || '1'}-${randomUUID()}.txt`,
  );
  const status = await (hooks.execute || executePi)({
    command: piExecutable,
    args: [...commandPrefix, ...args],
    cwd: workingDirectory,
    prompt,
    responseFile,
  });
  await appendFile(githubOutput, `response-path=${responseFile}\n`);
  const response = await readFile(responseFile);
  if (response.byteLength > RESPONSE_OUTPUT_MAX_BYTES) {
    fail(
      `response exceeds the ${RESPONSE_OUTPUT_MAX_BYTES}-byte GitHub Actions response limit; use response-path instead`,
    );
  }
  let outputDelimiter = `pi_agent_output_${randomUUID()}`;
  while (response.toString().split('\n').includes(outputDelimiter))
    outputDelimiter = `pi_agent_output_${randomUUID()}`;
  await appendFile(
    githubOutput,
    `response<<${outputDelimiter}\n${response.toString()}\n${outputDelimiter}\n`,
  );
  if (status !== 0) fail(`Pi exited with status ${status}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runAction().catch((error: unknown) => {
    console.error(`Pi Code Assist: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
