import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionConfig } from './inputs.ts';
import { runProcess, secondsLabel, type ProcessExit } from './process.ts';

export interface InstalledPi {
  readonly executable: string;
  readonly version: string;
  readonly installationRoot: string;
}

export type ProcessRunner = typeof runProcess;

function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  delete child.PI_AGENT_INPUT_API_KEY;
  delete child.PI_AGENT_INPUT_PROMPT;
  delete child.PI_AGENT_GITHUB_TOKEN;
  delete child.GH_TOKEN;
  return child;
}

function processFailure(result: ProcessExit, phase: string, timeoutMs: number): Error | undefined {
  if (result.timedOut) return new Error(`${phase} timed out after ${secondsLabel(timeoutMs)}`);
  if (result.error) return result.error;
  if (result.signal) return new Error(`${phase} was terminated by ${result.signal}`);
  return undefined;
}

export async function installPi(
  config: Pick<ActionConfig, 'runnerTemp' | 'version' | 'installTimeoutMs'>,
  env: NodeJS.ProcessEnv,
  processRunner: ProcessRunner = runProcess,
): Promise<InstalledPi> {
  const installationRoot = await mkdtemp(join(config.runnerTemp, `pi-agent-${config.version}-`));
  await mkdir(installationRoot, { recursive: true });
  await writeFile(
    join(installationRoot, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        dependencies: { '@earendil-works/pi-coding-agent': config.version },
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Installing Pi ${config.version} through Vite+...`);
  const environment = childEnvironment(env);
  const installation = await processRunner(
    'vp',
    ['install', '--ignore-scripts', '--no-lockfile', '--silent'],
    {
      cwd: installationRoot,
      env: environment,
      timeoutMs: config.installTimeoutMs,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    },
  );
  const installationError = processFailure(
    installation,
    'Pi installation',
    config.installTimeoutMs,
  );
  if (installationError) throw installationError;
  if (installation.code !== 0)
    throw new Error(`Pi installation failed with status ${installation.code ?? 1}`);

  const executable = join(
    installationRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'pi.cmd' : 'pi',
  );
  await access(executable, constants.X_OK).catch(() => {
    throw new Error(`Pi executable not found: ${executable}`);
  });

  const chunks: Buffer[] = [];
  const probe = await processRunner(executable, ['--version'], {
    cwd: installationRoot,
    env: environment,
    timeoutMs: config.installTimeoutMs,
    onStdout: (chunk) => chunks.push(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  const probeError = processFailure(probe, 'Pi version probe', config.installTimeoutMs);
  if (probeError) throw probeError;
  if (probe.code !== 0) throw new Error(`Pi version probe failed with status ${probe.code ?? 1}`);
  const observedVersion = Buffer.concat(chunks).toString('utf8').trim();
  if (observedVersion !== config.version)
    throw new Error(
      `installed Pi version mismatch: expected ${config.version}, received ${observedVersion}`,
    );

  console.log(`Pi ${observedVersion} installation verified.`);
  return Object.freeze({ executable, version: observedVersion, installationRoot });
}
