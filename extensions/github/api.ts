import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execRaw } from './execution.ts';

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_RECORDS = 500;

export interface PageResult {
  readonly records: unknown[];
  readonly count: number;
  readonly pages: number;
  readonly truncated: boolean;
  readonly continuation?: string;
}

export async function ghApi(path: string, signal?: AbortSignal, extra: string[] = []) {
  return await execRaw('gh', ['api', path, ...extra], signal);
}

export function responseUrl(response: unknown, operation: string): string {
  if (
    !response ||
    typeof response !== 'object' ||
    !('html_url' in response) ||
    typeof response.html_url !== 'string' ||
    !response.html_url
  )
    throw new Error(`GitHub ${operation} response did not contain an html_url`);
  return response.html_url;
}

export async function paged(
  path: string,
  signal?: AbortSignal,
  objectKey?: string,
): Promise<PageResult> {
  const records: unknown[] = [];
  let page = 1;
  let totalCount: number | undefined;
  for (; page <= MAX_PAGES && records.length < MAX_RECORDS; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const request = `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`;
    const payload = JSON.parse(await ghApi(request, signal));
    const value = objectKey ? payload[objectKey] : payload;
    if (!Array.isArray(value)) throw new Error(`Expected GitHub API records from: ${path}`);
    if (objectKey && Number.isInteger(payload.total_count)) totalCount = payload.total_count;
    records.push(...value.slice(0, MAX_RECORDS - records.length));
    const complete =
      totalCount !== undefined ? records.length >= totalCount : value.length < PAGE_SIZE;
    if (complete) return { records, count: records.length, pages: page, truncated: false };
    if (!value.length) break;
  }
  const separator = path.includes('?') ? '&' : '?';
  return {
    records,
    count: records.length,
    pages: Math.min(page - 1, MAX_PAGES),
    truncated: true,
    continuation: `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
  };
}

export function pageMetadata(value: PageResult) {
  return {
    count: value.count,
    pages: value.pages,
    truncated: value.truncated,
    continuation: value.continuation,
  };
}

export async function apiWithJson(
  path: string,
  method: string,
  body: unknown,
  signal?: AbortSignal,
) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-agent-github-'));
  const file = join(directory, 'request.json');
  await writeFile(file, JSON.stringify(body), { mode: 0o600 });
  try {
    return await ghApi(path, signal, ['--method', method, '--input', file]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
