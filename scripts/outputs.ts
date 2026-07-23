import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';

export const RESPONSE_OUTPUT_MAX_BYTES = 400_000;

export interface PublishedResponse {
  readonly empty: boolean;
  readonly responsePath: string;
}

function delimiterFor(response: string): string {
  let delimiter = `pi_agent_output_${randomUUID()}`;
  const lines = new Set(response.split('\n'));
  while (lines.has(delimiter)) delimiter = `pi_agent_output_${randomUUID()}`;
  return delimiter;
}

export async function publishResponse(
  githubOutput: string,
  responsePath: string,
): Promise<PublishedResponse> {
  const response = await readFile(responsePath);
  const text = response.toString('utf8');
  if (!text.trim()) return Object.freeze({ empty: true, responsePath });

  await appendFile(githubOutput, `response-path=${responsePath}\n`);
  if (response.byteLength > RESPONSE_OUTPUT_MAX_BYTES) {
    throw new Error(
      `response exceeds the ${RESPONSE_OUTPUT_MAX_BYTES}-byte GitHub Actions response limit; use response-path instead`,
    );
  }
  const delimiter = delimiterFor(text);
  await appendFile(githubOutput, `response<<${delimiter}\n${text}\n${delimiter}\n`);
  return Object.freeze({ empty: false, responsePath });
}
