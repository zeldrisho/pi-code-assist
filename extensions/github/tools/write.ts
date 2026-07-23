import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { apiWithJson, ghApi, responseUrl } from '../api.ts';
import { execRaw } from '../execution.ts';
import { bounded, textResult } from '../output.ts';
import { commitChanges, numberOrEvent, repository, safePaths } from '../repository.ts';

export function registerWriteTools(pi: ExtensionAPI): void {
  const commitPaths = Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: 'Explicit workspace-relative file paths to stage and commit',
  });

  pi.registerTool({
    name: 'post_comment',
    label: 'Post GitHub comment',
    description:
      'Post a comment on a GitHub issue or pull request. Requires issues:write or pull-requests:write.',
    promptSnippet: 'Post an issue or pull request comment',
    parameters: Type.Object({
      number: Type.Optional(Type.Integer({ minimum: 1 })),
      body: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal) {
      const response: unknown = JSON.parse(
        await apiWithJson(
          `repos/${repository()}/issues/${numberOrEvent(params.number)}/comments`,
          'POST',
          { body: params.body },
          signal,
        ),
      );
      return textResult(
        bounded(`Posted comment: ${responseUrl(response, 'comment')}`),
        response as Record<string, unknown>,
      );
    },
  });

  pi.registerTool({
    name: 'create_pull_request_review',
    label: 'Create pull request review',
    description: 'Create a pull request review, optionally with inline comments.',
    promptSnippet: 'Create a GitHub pull request review',
    parameters: Type.Object({
      pull_number: Type.Optional(Type.Integer({ minimum: 1 })),
      event: StringEnum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const),
      body: Type.Optional(Type.String()),
      comments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String(),
            line: Type.Integer({ minimum: 1 }),
            side: StringEnum(['LEFT', 'RIGHT'] as const),
            body: Type.String({ minLength: 1 }),
            start_line: Type.Optional(Type.Integer({ minimum: 1 })),
            start_side: Type.Optional(StringEnum(['LEFT', 'RIGHT'] as const)),
          }),
        ),
      ),
    }),
    async execute(_id, params, signal) {
      const response: unknown = JSON.parse(
        await apiWithJson(
          `repos/${repository()}/pulls/${numberOrEvent(params.pull_number)}/reviews`,
          'POST',
          { event: params.event, body: params.body, comments: params.comments },
          signal,
        ),
      );
      return textResult(
        bounded(`Created review: ${responseUrl(response, 'review')}`),
        response as Record<string, unknown>,
      );
    },
  });

  pi.registerTool({
    name: 'create_pull_request',
    label: 'Create pull request',
    description: 'Commit only explicit paths on a new branch, push it, and create a pull request.',
    promptSnippet: 'Commit selected changes and create a GitHub pull request',
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      body: Type.String(),
      commit_message: Type.String({ minLength: 1 }),
      paths: commitPaths,
      base: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9._/-]+$' })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const branch =
        params.branch ??
        `pi/run-${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
      if (branch.startsWith('-') || branch.includes('..') || branch.endsWith('/'))
        throw new Error('Invalid branch name');
      await execRaw('git', ['check-ref-format', '--branch', branch], signal);
      await safePaths(params.paths, ctx);
      await execRaw('git', ['switch', '--create', branch], signal);
      await commitChanges(params.commit_message, params.paths, signal, ctx);
      await execRaw(
        'git',
        ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`],
        signal,
      );
      const body: Record<string, string> = { title: params.title, body: params.body, head: branch };
      if (params.base) body.base = params.base;
      const response: unknown = JSON.parse(
        await apiWithJson(`repos/${repository()}/pulls`, 'POST', body, signal),
      );
      const url = responseUrl(response, 'pull request creation');
      return textResult(bounded(`Created pull request: ${url}`), {
        url,
        branch,
        paths: params.paths,
      });
    },
  });

  pi.registerTool({
    name: 'update_pull_request',
    label: 'Update pull request',
    description:
      'Commit only explicit paths and push them to an existing same-repository pull request.',
    promptSnippet: 'Commit selected changes and update a GitHub pull request',
    parameters: Type.Object({
      pull_number: Type.Optional(Type.Integer({ minimum: 1 })),
      commit_message: Type.String({ minLength: 1 }),
      paths: commitPaths,
      title: Type.Optional(Type.String({ minLength: 1 })),
      body: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const repo = repository();
      const number = numberOrEvent(params.pull_number);
      const pull = JSON.parse(await ghApi(`repos/${repo}/pulls/${number}`, signal));
      const pullUrl = responseUrl(pull, 'pull request');
      if (pull.head?.repo?.full_name !== repo)
        throw new Error('Updating pull requests from forks is not supported');
      const currentBranch = (await execRaw('git', ['branch', '--show-current'], signal)).trim();
      if (currentBranch !== pull.head.ref)
        throw new Error(
          `Current branch ${currentBranch || '(detached)'} does not match pull request branch ${pull.head.ref}`,
        );
      await commitChanges(params.commit_message, params.paths, signal, ctx);
      await execRaw('git', ['push', 'origin', `HEAD:refs/heads/${pull.head.ref}`], signal);
      if (params.title !== undefined || params.body !== undefined) {
        const body: Record<string, string> = {};
        if (params.title !== undefined) body.title = params.title;
        if (params.body !== undefined) body.body = params.body;
        const response: unknown = JSON.parse(
          await apiWithJson(`repos/${repo}/pulls/${number}`, 'PATCH', body, signal),
        );
        responseUrl(response, 'pull request update');
      }
      return textResult(bounded(`Updated pull request: ${pullUrl}`), {
        url: pullUrl,
        branch: pull.head.ref,
        paths: params.paths,
      });
    },
  });
}
