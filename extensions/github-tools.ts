import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT_BYTES = 50_000;
const MAX_OUTPUT_LINES = 2_000;

type Mode = "read" | "write";

function targetNumber(): number | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return undefined;

  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const value = event.pull_request?.number ?? event.issue?.number ?? event.number;
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function repository(): string {
  const value = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GITHUB_REPOSITORY must identify an owner/repository");
  }
  return value;
}

function numberOrEvent(value?: number): number {
  const result = value ?? targetNumber();
  if (!result) throw new Error("Provide a GitHub issue or pull request number");
  return result;
}

function truncate(value: string, keepTail = false, maxBytes = MAX_OUTPUT_BYTES): string {
  const lines = value.split("\n");
  let selected = lines;
  let truncated = false;

  if (lines.length > MAX_OUTPUT_LINES) {
    selected = keepTail ? lines.slice(-MAX_OUTPUT_LINES) : lines.slice(0, MAX_OUTPUT_LINES);
    truncated = true;
  }

  let output = selected.join("\n");
  const bytes = Buffer.byteLength(output);
  if (bytes > maxBytes) {
    const buffer = Buffer.from(output);
    output = (keepTail ? buffer.subarray(buffer.length - maxBytes) : buffer.subarray(0, maxBytes)).toString("utf8");
    truncated = true;
  }

  return truncated ? `${output}\n\n[Output truncated to ${maxBytes} bytes / ${MAX_OUTPUT_LINES} lines]` : output;
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function githubTools(pi: ExtensionAPI) {
  const mode = process.env.PI_AGENT_GITHUB_TOOLS as Mode | undefined;
  if (mode !== "read" && mode !== "write") return;

  async function exec(command: string, args: string[], signal?: AbortSignal, keepTail = false) {
    const result = await pi.exec(command, args, { signal, timeout: 120_000 });
    if (result.code !== 0) {
      throw new Error(truncate(result.stderr || result.stdout || `${command} exited with status ${result.code}`, true));
    }
    return truncate(result.stdout, keepTail);
  }

  async function ghApi(path: string, signal?: AbortSignal, extra: string[] = []) {
    return exec("gh", ["api", path, ...extra], signal);
  }

  pi.registerTool({
    name: "get_issue_or_pr_thread",
    label: "Get issue or PR thread",
    description: "Get an issue or pull request and its comments. For pull requests, also includes reviews and inline review comments.",
    promptSnippet: "Read a GitHub issue or pull request thread",
    parameters: Type.Object({
      number: Type.Optional(Type.Integer({ minimum: 1, description: "Issue or pull request number; defaults to the triggering event" })),
    }),
    async execute(_id, params, signal) {
      const repo = repository();
      const number = numberOrEvent(params.number);
      const issue = JSON.parse(await ghApi(`repos/${repo}/issues/${number}`, signal));
      const comments = JSON.parse(await ghApi(`repos/${repo}/issues/${number}/comments?per_page=100`, signal));
      const result: Record<string, unknown> = { issue, comments };
      if (issue.pull_request) {
        result.reviews = JSON.parse(await ghApi(`repos/${repo}/pulls/${number}/reviews?per_page=100`, signal));
        result.review_comments = JSON.parse(await ghApi(`repos/${repo}/pulls/${number}/comments?per_page=100`, signal));
      }
      return textResult(truncate(JSON.stringify(result, null, 2)), { number, is_pull_request: Boolean(issue.pull_request) });
    },
  });

  pi.registerTool({
    name: "get_pr_diff",
    label: "Get PR diff",
    description: "Get a pull request diff. Output is truncated to protect model context.",
    promptSnippet: "Fetch a GitHub pull request diff",
    parameters: Type.Object({
      pull_number: Type.Optional(Type.Integer({ minimum: 1, description: "Pull request number; defaults to the triggering event" })),
    }),
    async execute(_id, params, signal) {
      const number = numberOrEvent(params.pull_number);
      const diff = await ghApi(`repos/${repository()}/pulls/${number}`, signal, ["-H", "Accept: application/vnd.github.diff"]);
      return textResult(diff, { pull_number: number });
    },
  });

  pi.registerTool({
    name: "get_ci_status",
    label: "Get CI status",
    description: "Get check runs and workflow runs for a pull request or Git ref.",
    promptSnippet: "Inspect GitHub CI status",
    parameters: Type.Object({
      pull_number: Type.Optional(Type.Integer({ minimum: 1, description: "Pull request number; defaults to the triggering event when ref is omitted" })),
      ref: Type.Optional(Type.String({ description: "Commit SHA, branch, or tag" })),
    }),
    async execute(_id, params, signal) {
      const repo = repository();
      let ref = params.ref;
      if (!ref) {
        const number = numberOrEvent(params.pull_number);
        const pull = JSON.parse(await ghApi(`repos/${repo}/pulls/${number}`, signal));
        ref = pull.head.sha;
      }
      const checks = JSON.parse(await ghApi(`repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`, signal));
      const workflows = JSON.parse(await ghApi(`repos/${repo}/actions/runs?head_sha=${encodeURIComponent(ref)}&per_page=100`, signal));
      const result = { ref, check_runs: checks.check_runs, workflow_runs: workflows.workflow_runs };
      return textResult(truncate(JSON.stringify(result, null, 2)), { ref });
    },
  });

  pi.registerTool({
    name: "get_workflow_run_logs",
    label: "Get workflow run logs",
    description: "Get logs for a GitHub Actions workflow run. The last 50 KB / 2000 lines are returned.",
    promptSnippet: "Read GitHub Actions workflow logs",
    parameters: Type.Object({ run_id: Type.Integer({ minimum: 1 }) }),
    async execute(_id, params, signal) {
      const logs = await exec("gh", ["run", "view", String(params.run_id), "--log", "--repo", repository()], signal, true);
      return textResult(logs, { run_id: params.run_id });
    },
  });

  if (mode !== "write") return;

  async function apiWithJson(path: string, method: string, body: unknown, signal?: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), "pi-agent-github-"));
    const file = join(directory, "request.json");
    await writeFile(file, JSON.stringify(body), { mode: 0o600 });
    try {
      return await ghApi(path, signal, ["--method", method, "--input", file]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function commitChanges(message: string, signal?: AbortSignal) {
    const status = await exec("git", ["status", "--porcelain"], signal);
    if (!status.trim()) throw new Error("There are no workspace changes to commit");
    await exec("git", ["config", "user.name", "github-actions[bot]"], signal);
    await exec("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], signal);
    await exec("git", ["add", "--all"], signal);
    await exec("git", ["commit", "-m", message], signal);
  }

  pi.registerTool({
    name: "post_comment",
    label: "Post GitHub comment",
    description: "Post a comment on a GitHub issue or pull request. Requires issues:write or pull-requests:write workflow permission.",
    promptSnippet: "Post an issue or pull request comment",
    parameters: Type.Object({
      number: Type.Optional(Type.Integer({ minimum: 1, description: "Issue or pull request number; defaults to the triggering event" })),
      body: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal) {
      const number = numberOrEvent(params.number);
      const response = JSON.parse(await apiWithJson(`repos/${repository()}/issues/${number}/comments`, "POST", { body: params.body }, signal));
      return textResult(`Posted comment: ${response.html_url}`, response);
    },
  });

  pi.registerTool({
    name: "create_pull_request_review",
    label: "Create pull request review",
    description: "Create a pull request review, optionally with inline comments. Requires pull-requests:write workflow permission.",
    promptSnippet: "Create a GitHub pull request review",
    parameters: Type.Object({
      pull_number: Type.Optional(Type.Integer({ minimum: 1, description: "Pull request number; defaults to the triggering event" })),
      event: StringEnum(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const),
      body: Type.Optional(Type.String()),
      comments: Type.Optional(Type.Array(Type.Object({
        path: Type.String(),
        line: Type.Integer({ minimum: 1 }),
        side: StringEnum(["LEFT", "RIGHT"] as const),
        body: Type.String({ minLength: 1 }),
        start_line: Type.Optional(Type.Integer({ minimum: 1 })),
        start_side: Type.Optional(StringEnum(["LEFT", "RIGHT"] as const)),
      }))),
    }),
    async execute(_id, params, signal) {
      const number = numberOrEvent(params.pull_number);
      const response = JSON.parse(await apiWithJson(`repos/${repository()}/pulls/${number}/reviews`, "POST", {
        event: params.event,
        body: params.body,
        comments: params.comments,
      }, signal));
      return textResult(`Created review: ${response.html_url}`, response);
    },
  });

  pi.registerTool({
    name: "create_pull_request",
    label: "Create pull request",
    description: "Commit workspace changes on a new branch, push it to origin, and create a pull request. Checkout credentials and contents:write/pull-requests:write permissions are required.",
    promptSnippet: "Commit changes and create a GitHub pull request",
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      body: Type.String(),
      commit_message: Type.String({ minLength: 1 }),
      base: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._/-]+$" })),
    }),
    async execute(_id, params, signal) {
      const generated = `pi/run-${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
      const branch = params.branch ?? generated;
      if (branch.startsWith("-") || branch.includes("..") || branch.endsWith("/")) throw new Error("Invalid branch name");
      await exec("git", ["switch", "--create", branch], signal);
      await commitChanges(params.commit_message, signal);
      await exec("git", ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], signal);
      const args = ["pr", "create", "--repo", repository(), "--head", branch, "--title", params.title, "--body", params.body];
      if (params.base) args.push("--base", params.base);
      const url = (await exec("gh", args, signal)).trim();
      return textResult(`Created pull request: ${url}`, { url, branch });
    },
  });

  pi.registerTool({
    name: "update_pull_request",
    label: "Update pull request",
    description: "Commit workspace changes and push them to an existing same-repository pull request, optionally updating its title or body.",
    promptSnippet: "Commit changes and update a GitHub pull request",
    parameters: Type.Object({
      pull_number: Type.Optional(Type.Integer({ minimum: 1, description: "Pull request number; defaults to the triggering event" })),
      commit_message: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String({ minLength: 1 })),
      body: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      const repo = repository();
      const number = numberOrEvent(params.pull_number);
      const pull = JSON.parse(await ghApi(`repos/${repo}/pulls/${number}`, signal));
      if (pull.head.repo?.full_name !== repo) throw new Error("Updating pull requests from forks is not supported");
      await commitChanges(params.commit_message, signal);
      await exec("git", ["push", "origin", `HEAD:refs/heads/${pull.head.ref}`], signal);
      if (params.title !== undefined || params.body !== undefined) {
        const body: Record<string, string> = {};
        if (params.title !== undefined) body.title = params.title;
        if (params.body !== undefined) body.body = params.body;
        await apiWithJson(`repos/${repo}/pulls/${number}`, "PATCH", body, signal);
      }
      return textResult(`Updated pull request: ${pull.html_url}`, { url: pull.html_url, branch: pull.head.ref });
    },
  });
}
