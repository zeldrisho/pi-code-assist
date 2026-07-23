import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { execRaw } from './execution.ts';

export function targetNumber(): number | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return undefined;
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const value = event.pull_request?.number ?? event.issue?.number ?? event.number;
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function repository(): string {
  const value = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new Error('GITHUB_REPOSITORY must identify an owner/repository');
  return value;
}

export function numberOrEvent(value?: number): number {
  const result = value ?? targetNumber();
  if (!result)
    throw new Error(
      'Provide a GitHub issue or pull request number; the event payload was missing or malformed',
    );
  return result;
}

export async function safePaths(paths: string[], ctx: ExtensionContext) {
  const root = await realpath(ctx.cwd);
  const accepted: string[] = [];
  for (const path of paths) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new Error(`Commit path must be workspace-relative without traversal: ${path}`);
    const absolute = resolve(root, path);
    const parent = await realpath(dirname(absolute));
    const fileStat = await stat(absolute).catch(() => undefined);
    if (fileStat?.isDirectory())
      throw new Error(`Commit paths must identify files, not directories: ${path}`);
    const canonical = fileStat
      ? await realpath(absolute)
      : resolve(parent, absolute.slice(dirname(absolute).length + 1));
    const within = relative(root, canonical);
    if (!within || within.startsWith('..') || isAbsolute(within))
      throw new Error(`Commit path must stay within the workspace: ${path}`);
    const changed = await execRaw('git', ['status', '--porcelain', '--', path]);
    if (!changed.trim()) throw new Error(`Commit path has no workspace change: ${path}`);
    accepted.push(path);
  }
  return accepted;
}

export async function commitChanges(
  message: string,
  paths: string[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const selected = await safePaths(paths, ctx);
  await execRaw('git', ['config', 'user.name', 'github-actions[bot]'], signal);
  await execRaw(
    'git',
    ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'],
    signal,
  );
  await execRaw('git', ['add', '--', ...selected], signal);
  const staged = await execRaw(
    'git',
    ['diff', '--cached', '--name-only', '--', ...selected],
    signal,
  );
  if (!staged.trim()) throw new Error('The selected paths produced an empty commit');
  await execRaw('git', ['commit', '-m', message, '--', ...selected], signal);
}
