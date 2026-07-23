import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';
import { GITHUB_READ_TOOLS, GITHUB_WRITE_TOOLS } from '../extensions/github/manifest.ts';
import type { InstalledPi } from './installation.ts';
import type { ActionConfig } from './inputs.ts';
import { runProcess, secondsLabel, type ProcessExit } from './process.ts';

export interface PiInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly prompt: string;
  readonly responseFile: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
}

export interface InvocationResult {
  readonly status: number;
  readonly responseFile: string;
}

export function activeGitHubTools(config: Pick<ActionConfig, 'githubTools'>): readonly string[] {
  if (config.githubTools === 'none') return Object.freeze([]);
  if (config.githubTools === 'read') return GITHUB_READ_TOOLS;
  return Object.freeze([...GITHUB_READ_TOOLS, ...GITHUB_WRITE_TOOLS]);
}

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  config: Pick<ActionConfig, 'githubTools' | 'githubToken'>,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    ...source,
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PI_AGENT_GITHUB_TOOLS: config.githubTools,
  };
  delete child.PI_AGENT_INPUT_API_KEY;
  delete child.PI_AGENT_INPUT_PROMPT;
  delete child.PI_AGENT_GITHUB_TOKEN;
  delete child.GH_TOKEN;
  if (config.githubTools !== 'none') child.GH_TOKEN = config.githubToken;
  return child;
}

export function buildPiArguments(config: ActionConfig): readonly string[] {
  const args = ['--print', '--no-session'];
  if (config.thinking) args.push('--thinking', config.thinking);
  args.push(
    config.projectTrust ? '--approve' : '--no-approve',
    '--provider',
    config.provider,
    '--model',
    config.model,
    '--api-key',
    config.apiKey,
  );
  for (const source of config.packageSources) args.push('--extension', source);

  const githubToolNames = activeGitHubTools(config);
  if (githubToolNames.length) args.push('--extension', config.githubExtensionPath);
  let selectedTools = config.selectedTools;
  if (githubToolNames.length && selectedTools !== 'all')
    selectedTools = selectedTools
      ? `${selectedTools},${githubToolNames.join(',')}`
      : githubToolNames.join(',');
  if (selectedTools && selectedTools !== 'all') args.push('--tools', selectedTools);
  return Object.freeze(args);
}

export function createInvocation(
  config: ActionConfig,
  installed: InstalledPi,
  env: NodeJS.ProcessEnv,
): PiInvocation {
  return Object.freeze({
    command: installed.executable,
    args: buildPiArguments(config),
    cwd: config.workingDirectory,
    prompt: config.prompt,
    responseFile: join(
      config.runnerTemp,
      `pi-agent-response-${config.runId}-${config.runAttempt}-${randomUUID()}.txt`,
    ),
    timeoutMs: config.executionTimeoutMs,
    env: buildChildEnvironment(env, config),
  });
}

function invocationFailure(result: ProcessExit, timeoutMs: number): Error | undefined {
  if (result.timedOut)
    return new Error(`Pi/model invocation timed out after ${secondsLabel(timeoutMs)}`);
  if (result.error) return result.error;
  if (result.signal) return new Error(`Pi was terminated by ${result.signal}`);
  return undefined;
}

export async function invokePi(
  config: ActionConfig,
  installed: InstalledPi,
  env: NodeJS.ProcessEnv,
  processRunner: typeof runProcess = runProcess,
): Promise<InvocationResult> {
  const invocation = createInvocation(config, installed, env);
  const output = createWriteStream(invocation.responseFile, { flags: 'wx', mode: 0o600 });
  let outputError: Error | undefined;
  output.once('error', (error) => {
    outputError = error;
  });
  const result = await processRunner(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    input: invocation.prompt,
    timeoutMs: invocation.timeoutMs,
    onStdout: (chunk) => {
      output.write(chunk);
      process.stdout.write(chunk);
    },
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  output.end();
  await finished(output).catch((error: unknown) => {
    outputError ??= error instanceof Error ? error : new Error(String(error));
  });
  if (outputError) throw outputError;
  const error = invocationFailure(result, invocation.timeoutMs);
  if (error) throw error;
  return Object.freeze({ status: result.code ?? 1, responseFile: invocation.responseFile });
}
