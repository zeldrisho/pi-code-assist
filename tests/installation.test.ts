import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { installPi } from '../scripts/installation.ts';
import type { ProcessOptions } from '../scripts/process.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-installation-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config() {
  return { runnerTemp: root, version: '0.80.10', installTimeoutMs: 5_000 };
}

function successfulRunner(
  observed = '0.80.10',
  calls: Array<{ command: string; args: readonly string[]; options: ProcessOptions }> = [],
) {
  return async (command: string, args: readonly string[], options: ProcessOptions) => {
    calls.push({ command, args, options });
    if (command === 'vp') {
      const executable = join(
        options.cwd,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'pi.cmd' : 'pi',
      );
      await mkdir(join(options.cwd, 'node_modules', '.bin'), { recursive: true });
      await writeFile(executable, '');
      await chmod(executable, 0o755);
    } else options.onStdout?.(Buffer.from(`${observed}\n`));
    return { code: 0, signal: null, timedOut: false } as const;
  };
}

describe('Pi installation', () => {
  test('uses a fresh root, exact pin, disabled scripts, integrity install, and version probe', async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: ProcessOptions }> = [];
    const env = {
      KEEP: 'yes',
      PI_AGENT_INPUT_API_KEY: 'secret',
      PI_AGENT_INPUT_PROMPT: 'prompt',
      PI_AGENT_GITHUB_TOKEN: 'token',
      GH_TOKEN: 'token',
    };
    const first = await installPi(config(), env, successfulRunner('0.80.10', calls));
    const second = await installPi(config(), env, successfulRunner());
    expect(first.installationRoot).not.toBe(second.installationRoot);
    const manifest = await import('node:fs/promises').then(({ readFile }) =>
      readFile(join(first.installationRoot, 'package.json'), 'utf8'),
    );
    expect(JSON.parse(manifest).dependencies).toEqual({
      '@earendil-works/pi-coding-agent': '0.80.10',
    });
    expect(calls[0].args).toEqual(['install', '--ignore-scripts', '--no-lockfile', '--silent']);
    expect(calls[1].args).toEqual(['--version']);
    expect(calls[0].options.env).toMatchObject({
      KEEP: 'yes',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    });
    expect(calls[0].options.env.PI_AGENT_INPUT_API_KEY).toBeUndefined();
    expect(calls[0].options.env.GH_TOKEN).toBeUndefined();
  });

  test('rejects installation failures before probing', async () => {
    let calls = 0;
    await expect(
      installPi(config(), {}, async () => {
        calls += 1;
        return { code: 9, signal: null, timedOut: false };
      }),
    ).rejects.toThrow('installation failed with status 9');
    expect(calls).toBe(1);
  });

  test('rejects probe failures and version mismatches', async () => {
    await expect(installPi(config(), {}, successfulRunner('0.80.9'))).rejects.toThrow(
      'version mismatch',
    );
    let call = 0;
    await expect(
      installPi(config(), {}, async (command, _args, options) => {
        call += 1;
        if (call === 1) {
          const executable = join(options.cwd, 'node_modules', '.bin', 'pi');
          await mkdir(join(options.cwd, 'node_modules', '.bin'), { recursive: true });
          await writeFile(executable, '');
          await chmod(executable, 0o755);
          return { code: 0, signal: null, timedOut: false };
        }
        return { code: 4, signal: null, timedOut: false };
      }),
    ).rejects.toThrow('version probe failed with status 4');
  });

  test('reports installation timeout without probing', async () => {
    await expect(
      installPi(config(), {}, async () => ({ code: null, signal: 'SIGTERM', timedOut: true })),
    ).rejects.toThrow('installation timed out after 5 seconds');
  });
});
