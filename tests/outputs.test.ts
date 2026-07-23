import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { publishResponse, RESPONSE_OUTPUT_MAX_BYTES } from '../scripts/outputs.ts';

let root: string;
let output: string;
let response: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-outputs-'));
  output = join(root, 'output');
  response = join(root, 'response');
  await writeFile(output, '');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GitHub output publication', () => {
  test.each(['', ' \n\t '])('publishes no output for an empty response', async (value) => {
    await writeFile(response, value);
    expect(await publishResponse(output, response)).toMatchObject({ empty: true });
    expect(await readFile(output, 'utf8')).toBe('');
  });

  test('publishes response-path first and uses a collision-safe multiline delimiter', async () => {
    await writeFile(response, 'first\npi_agent_output_possible_collision\nlast\n');
    await publishResponse(output, response);
    const published = await readFile(output, 'utf8');
    expect(published.startsWith(`response-path=${response}\nresponse<<`)).toBe(true);
    const delimiter = published.match(/^response<<(.+)$/m)?.[1];
    expect(delimiter).toBeTruthy();
    expect(['first', 'pi_agent_output_possible_collision', 'last']).not.toContain(delimiter);
    expect(published).toContain('first\n');
  });

  test('preserves the 400,000-byte expression boundary', async () => {
    await writeFile(response, 'x'.repeat(RESPONSE_OUTPUT_MAX_BYTES));
    await expect(publishResponse(output, response)).resolves.toMatchObject({ empty: false });
    await writeFile(output, '');
    await writeFile(response, 'x'.repeat(RESPONSE_OUTPUT_MAX_BYTES + 1));
    await expect(publishResponse(output, response)).rejects.toThrow('use response-path instead');
    const published = await readFile(output, 'utf8');
    expect(published).toBe(`response-path=${response}\n`);
  });

  test('measures UTF-8 bytes rather than characters', async () => {
    await writeFile(response, '😀'.repeat(100_000));
    await expect(publishResponse(output, response)).resolves.toBeDefined();
    await writeFile(output, '');
    await writeFile(response, `${'😀'.repeat(100_000)}x`);
    await expect(publishResponse(output, response)).rejects.toThrow('400000-byte');
  });
});
