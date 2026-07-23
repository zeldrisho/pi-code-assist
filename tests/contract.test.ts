import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vite-plus/test';
import { GITHUB_READ_TOOLS, GITHUB_WRITE_TOOLS } from '../extensions/github/manifest.ts';

interface Metadata {
  default: string;
  description: string;
  required: string;
}

function yamlSection(document: string, name: string): Map<string, Metadata> {
  const lines = document.split('\n');
  const start = lines.indexOf(`${name}:`);
  if (start < 0) throw new Error(`Missing ${name} section in action.yml`);
  const values = new Map<string, Metadata>();
  let current: Metadata | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z][a-z-]*:/.test(line)) break;
    const item = line.match(/^  ([a-z][a-z-]*):$/);
    if (item) {
      current = { default: '—', description: '', required: 'false' };
      values.set(item[1], current);
      continue;
    }
    const field = line.match(/^    (default|description|required):\s*(.*)$/);
    if (current && field) {
      current[field[1] as keyof Metadata] = field[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return values;
}

function markdownTable(document: string, heading: string): Map<string, string[]> {
  const match = document.match(
    new RegExp(`^## ${heading}\\n.*?\\n(\\| .*?)(?=\\n\\n|\\n## )`, 'ms'),
  );
  if (!match) throw new Error(`Missing README ${heading} table`);
  return new Map(
    match[1]
      .split('\n')
      .slice(2)
      .map((line) =>
        line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim()),
      )
      .filter((cells) => cells.length >= 2)
      .map((cells) => [cells[0].replaceAll('`', ''), cells]),
  );
}

const action = await readFile('action.yml', 'utf8');
const ci = await readFile('.github/workflows/ci.yml', 'utf8');
const release = await readFile('.github/workflows/release.yml', 'utf8');
const readme = await readFile('README.md', 'utf8');
const runtime = await readFile('scripts/inputs.ts', 'utf8');

describe('public action contract', () => {
  test('keeps action and README inputs and outputs synchronized', () => {
    const inputs = yamlSection(action, 'inputs');
    const outputs = yamlSection(action, 'outputs');
    const readmeInputs = markdownTable(readme, 'Inputs');
    const readmeOutputs = markdownTable(readme, 'Outputs');
    expect([...inputs.keys()]).toEqual([...readmeInputs.keys()]);
    expect([...outputs.keys()]).toEqual([...readmeOutputs.keys()]);
    for (const [name, metadata] of inputs) {
      const documented = readmeInputs.get(name)!;
      expect(documented[1], `required value for ${name}`).toBe(
        metadata.required === 'true' ? 'Yes' : 'No',
      );
      const expectedDefault =
        metadata.default === '—' && name === 'thinking' ? 'Pi default' : metadata.default;
      expect(documented[2].replaceAll('`', ''), `default value for ${name}`).toBe(expectedDefault);
    }
  });

  test('keeps documented enum values and package path rules synchronized', () => {
    const inputs = yamlSection(action, 'inputs');
    const readmeInputs = markdownTable(readme, 'Inputs');
    for (const name of ['thinking', 'github-tools']) {
      const actionValues = new Set(
        inputs
          .get(name)!
          .description.match(/\b(?:off|minimal|low|medium|high|xhigh|max|none|read|write)\b/g),
      );
      const readmeValues = new Set(
        [
          ...readmeInputs
            .get(name)![3]
            .matchAll(/`(off|minimal|low|medium|high|xhigh|max|none|read|write)`/g),
        ].map((match) => match[1]),
      );
      expect(actionValues).toEqual(readmeValues);
    }
    expect(readme).toContain('must begin with `./`');
  });

  test('requires callers to select an exact Pi version', () => {
    const versionInput = yamlSection(action, 'inputs').get('pi-version')!;
    expect(versionInput.required).toBe('true');
    expect(versionInput.default).toBe('—');
    expect(runtime).not.toContain('DEFAULT_PI_VERSION');
    expect(runtime).toContain("required(env, 'PI_AGENT_INPUT_VERSION', 'pi-version is required')");
  });

  test('keeps setup-vp standalone by default without automatic workspace installation', () => {
    const setupInput = yamlSection(action, 'inputs').get('setup-vp')!;
    expect(setupInput.default).toBe('true');
    expect(action).toContain("if: inputs.setup-vp == 'true'");
    for (const document of [action, ci, release]) {
      expect(document.match(/uses: voidzero-dev\/setup-vp@/g)).toHaveLength(1);
      expect(document.match(/run-install: false/g)).toHaveLength(1);
    }
  });

  test('exports immutable GitHub tool catalogs for each mode', () => {
    expect(Object.isFrozen(GITHUB_READ_TOOLS)).toBe(true);
    expect(Object.isFrozen(GITHUB_WRITE_TOOLS)).toBe(true);
    expect(GITHUB_READ_TOOLS).toEqual([
      'get_issue_or_pr_thread',
      'get_pr_diff',
      'get_ci_status',
      'get_workflow_run_logs',
    ]);
    expect(GITHUB_WRITE_TOOLS).toEqual([
      'post_comment',
      'create_pull_request_review',
      'create_pull_request',
      'update_pull_request',
    ]);
  });
});
