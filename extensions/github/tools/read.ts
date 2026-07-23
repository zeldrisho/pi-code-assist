import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ghApi, paged, pageMetadata } from '../api.ts';
import { exec } from '../execution.ts';
import { bounded, textResult } from '../output.ts';
import { numberOrEvent, repository } from '../repository.ts';

function section(name: string, value: unknown, maxBytes: number) {
  const output = bounded(JSON.stringify(value, null, 2), false, maxBytes);
  return `## ${name}\n${output.text}${output.truncated ? `\n[Section truncated: ${output.returned_bytes}/${output.total_bytes} bytes]` : ''}`;
}

export function registerReadTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'get_issue_or_pr_thread',
    label: 'Get issue or PR thread',
    description:
      'Get an issue or pull request and bounded, paginated comments and reviews. Metadata reports truncation and continuation paths.',
    promptSnippet: 'Read a GitHub issue or pull request thread',
    parameters: Type.Object({
      number: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: 'Issue or pull request number; defaults to the triggering event',
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const repo = repository();
      const number = numberOrEvent(params.number);
      const issue = JSON.parse(await ghApi(`repos/${repo}/issues/${number}`, signal));
      const comments = await paged(`repos/${repo}/issues/${number}/comments`, signal);
      const sections = [section('issue', issue, 10_000), section('comments', comments, 12_000)];
      const details: Record<string, unknown> = {
        number,
        is_pull_request: Boolean(issue.pull_request),
        comments: pageMetadata(comments),
      };
      if (issue.pull_request) {
        const reviews = await paged(`repos/${repo}/pulls/${number}/reviews`, signal);
        const reviewComments = await paged(`repos/${repo}/pulls/${number}/comments`, signal);
        sections.push(
          section('reviews', reviews, 12_000),
          section('review_comments', reviewComments, 12_000),
        );
        details.reviews = pageMetadata(reviews);
        details.review_comments = pageMetadata(reviewComments);
      }
      return textResult(bounded(sections.join('\n\n')), details);
    },
  });

  pi.registerTool({
    name: 'get_pr_diff',
    label: 'Get PR diff',
    description:
      'Get up to 50 KB / 2000 lines of a pull request diff; details report when output is incomplete.',
    promptSnippet: 'Fetch a GitHub pull request diff',
    parameters: Type.Object({
      pull_number: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: 'Pull request number; defaults to the triggering event',
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const number = numberOrEvent(params.pull_number);
      const path = `repos/${repository()}/pulls/${number}`;
      return textResult(
        await exec('gh', ['api', path, '-H', 'Accept: application/vnd.github.diff'], signal),
        { pull_number: number },
      );
    },
  });

  pi.registerTool({
    name: 'get_ci_status',
    label: 'Get CI status',
    description:
      'Get bounded check runs and workflow runs for a pull request or Git ref, with truncation metadata.',
    promptSnippet: 'Inspect GitHub CI status',
    parameters: Type.Object({
      pull_number: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: 'Pull request number; defaults to the triggering event when ref is omitted',
        }),
      ),
      ref: Type.Optional(Type.String({ description: 'Commit SHA, branch, or tag' })),
    }),
    async execute(_id, params, signal) {
      const repo = repository();
      let ref = params.ref;
      if (!ref) {
        const pull = JSON.parse(
          await ghApi(`repos/${repo}/pulls/${numberOrEvent(params.pull_number)}`, signal),
        );
        ref = pull.head?.sha;
        if (typeof ref !== 'string' || !ref)
          throw new Error('GitHub pull request response did not contain a head SHA');
      }
      const checkData = await paged(
        `repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs`,
        signal,
        'check_runs',
      );
      const workflowData = await paged(
        `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(ref)}`,
        signal,
        'workflow_runs',
      );
      return textResult(
        bounded(
          `${section('check_runs', checkData, 24_000)}\n\n${section('workflow_runs', workflowData, 24_000)}`,
        ),
        { ref, check_runs: pageMetadata(checkData), workflow_runs: pageMetadata(workflowData) },
      );
    },
  });

  pi.registerTool({
    name: 'get_workflow_run_logs',
    label: 'Get workflow run logs',
    description:
      'Get workflow logs. The last 50 KB / 2000 lines are returned and details report truncation.',
    promptSnippet: 'Read GitHub Actions workflow logs',
    parameters: Type.Object({ run_id: Type.Integer({ minimum: 1 }) }),
    async execute(_id, params, signal) {
      return textResult(
        await exec(
          'gh',
          ['run', 'view', String(params.run_id), '--log', '--repo', repository()],
          signal,
          true,
        ),
        { run_id: params.run_id },
      );
    },
  });
}
