import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_OUTPUT_BYTES = 50_000;
const MAX_OUTPUT_LINES = 2_000;
const MAX_API_BYTES = 1_000_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_RECORDS = 500;

type Mode = "read" | "write";
type ExecResult = { text: string; truncated: boolean; total_bytes: number; total_lines: number; returned_bytes: number; returned_lines: number };
type PageResult = { records: unknown[]; count: number; pages: number; truncated: boolean; continuation?: string };

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
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("GITHUB_REPOSITORY must identify an owner/repository");
  return value;
}

function numberOrEvent(value?: number): number {
  const result = value ?? targetNumber();
  if (!result) throw new Error("Provide a GitHub issue or pull request number; the event payload was missing or malformed");
  return result;
}

function bounded(value: string, keepTail = false, maxBytes = MAX_OUTPUT_BYTES): ExecResult {
  const lines = value.split("\n");
  let selected = lines;
  let truncated = false;
  if (lines.length > MAX_OUTPUT_LINES) {
    selected = keepTail ? lines.slice(-MAX_OUTPUT_LINES) : lines.slice(0, MAX_OUTPUT_LINES);
    truncated = true;
  }
  let output = selected.join("\n");
  if (Buffer.byteLength(output) > maxBytes) {
    const buffer = Buffer.from(output);
    let slice = keepTail ? buffer.subarray(buffer.length - maxBytes) : buffer.subarray(0, maxBytes);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (slice.length) {
      try {
        output = decoder.decode(slice);
        break;
      } catch {
        slice = keepTail ? slice.subarray(1) : slice.subarray(0, -1);
      }
    }
    truncated = true;
  }
  return {
    text: output,
    truncated,
    total_bytes: Buffer.byteLength(value),
    total_lines: lines.length,
    returned_bytes: Buffer.byteLength(output),
    returned_lines: output.split("\n").length,
  };
}

function textResult(result: ExecResult, details: Record<string, unknown> = {}) {
  const marker = result.truncated
    ? `\n\n[Output truncated: ${result.returned_bytes}/${result.total_bytes} bytes, ${result.returned_lines}/${result.total_lines} lines]`
    : "";
  return { content: [{ type: "text" as const, text: result.text + marker }], details: { ...details, ...result } };
}

export default function githubTools(pi: ExtensionAPI) {
  const mode = process.env.PI_AGENT_GITHUB_TOOLS as Mode | undefined;
  if (mode !== "read" && mode !== "write") return;

  async function execRaw(command: string, args: string[], signal?: AbortSignal, timeout = 120_000) {
    const result = await pi.exec(command, args, { signal, timeout });
    if (result.code !== 0) {
      const failure = bounded(result.stderr || result.stdout || `${command} exited with status ${result.code}`, true);
      throw new Error(failure.text + (failure.truncated ? "\n[Error output truncated]" : ""));
    }
    return result.stdout;
  }

  async function exec(command: string, args: string[], signal?: AbortSignal, keepTail = false) {
    return bounded(await execRaw(command, args, signal), keepTail);
  }

  async function ghApi(path: string, signal?: AbortSignal, extra: string[] = []) {
    const output = await execRaw("gh", ["api", path, ...extra], signal);
    if (Buffer.byteLength(output) > MAX_API_BYTES) throw new Error("GitHub API response exceeded the 1,000,000-byte request limit");
    return output;
  }

  async function paged(path: string, signal?: AbortSignal, objectKey?: string): Promise<PageResult> {
    const records: unknown[] = [];
    let page = 1;
    let totalCount: number | undefined;
    for (; page <= MAX_PAGES && records.length < MAX_RECORDS; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const request = `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`;
      const payload = JSON.parse(await ghApi(request, signal));
      const value = objectKey ? payload[objectKey] : payload;
      if (!Array.isArray(value)) throw new Error(`Expected GitHub API records from: ${path}`);
      if (objectKey && Number.isInteger(payload.total_count)) totalCount = payload.total_count;
      records.push(...value.slice(0, MAX_RECORDS - records.length));
      const complete = totalCount !== undefined ? records.length >= totalCount : value.length < PAGE_SIZE;
      if (complete) return { records, count: records.length, pages: page, truncated: false };
      if (!value.length) break;
    }
    const separator = path.includes("?") ? "&" : "?";
    return {
      records,
      count: records.length,
      pages: Math.min(page - 1, MAX_PAGES),
      truncated: true,
      continuation: `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
    };
  }

  function pageMetadata(value: PageResult) {
    return { count: value.count, pages: value.pages, truncated: value.truncated, continuation: value.continuation };
  }

  function section(name: string, value: unknown, maxBytes: number) {
    const output = bounded(JSON.stringify(value, null, 2), false, maxBytes);
    return `## ${name}\n${output.text}${output.truncated ? `\n[Section truncated: ${output.returned_bytes}/${output.total_bytes} bytes]` : ""}`;
  }

  pi.registerTool({
    name: "get_issue_or_pr_thread",
    label: "Get issue or PR thread",
    description: "Get an issue or pull request and bounded, paginated comments and reviews. Metadata reports truncation and continuation paths.",
    promptSnippet: "Read a GitHub issue or pull request thread",
    parameters: Type.Object({ number: Type.Optional(Type.Integer({ minimum: 1, description: "Issue or pull request number; defaults to the triggering event" })) }),
    async execute(_id, params, signal) {
      const repo = repository();
      const number = numberOrEvent(params.number);
      const issue = JSON.parse(await ghApi(`repos/${repo}/issues/${number}`, signal));
      const comments = await paged(`repos/${repo}/issues/${number}/comments`, signal);
      const sections = [section("issue", issue, 10_000), section("comments", comments, 12_000)];
      const details: Record<string, unknown> = { number, is_pull_request: Boolean(issue.pull_request), comments: pageMetadata(comments) };
      if (issue.pull_request) {
        const reviews = await paged(`repos/${repo}/pulls/${number}/reviews`, signal);
        const reviewComments = await paged(`repos/${repo}/pulls/${number}/comments`, signal);
        sections.push(section("reviews", reviews, 12_000), section("review_comments", reviewComments, 12_000));
        details.reviews = pageMetadata(reviews);
        details.review_comments = pageMetadata(reviewComments);
      }
      return textResult(bounded(sections.join("\n\n")), details);
    },
  });

  pi.registerTool({
    name: "get_pr_diff",
    label: "Get PR diff",
    description: "Get up to 50 KB / 2000 lines of a pull request diff; details report when output is incomplete.",
    promptSnippet: "Fetch a GitHub pull request diff",
    parameters: Type.Object({ pull_number: Type.Optional(Type.Integer({ minimum: 1, description: "Pull request number; defaults to the triggering event" })) }),
    async execute(_id, params, signal) {
      const number = numberOrEvent(params.pull_number);
      return textResult(bounded(await ghApi(`repos/${repository()}/pulls/${number}`, signal, ["-H", "Accept: application/vnd.github.diff"])), { pull_number: number });
    },
  });

  pi.registerTool({
    name: "get_ci_status",
    label: "Get CI status",
    description: "Get bounded check runs and workflow runs for a pull request or Git ref, with truncation metadata.",
    promptSnippet: "Inspect GitHub CI status",
    parameters: Type.Object({
      pull_number: Type.Optional(Type.Integer({ minimum: 1, description: "Pull request number; defaults to the triggering event when ref is omitted" })),
      ref: Type.Optional(Type.String({ description: "Commit SHA, branch, or tag" })),
    }),
    async execute(_id, params, signal) {
      const repo = repository();
      let ref = params.ref;
      if (!ref) {
        const pull = JSON.parse(await ghApi(`repos/${repo}/pulls/${numberOrEvent(params.pull_number)}`, signal));
        ref = pull.head?.sha;
        if (typeof ref !== "string" || !ref) throw new Error("GitHub pull request response did not contain a head SHA");
      }
      const checkData = await paged(`repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs`, signal, "check_runs");
      const workflowData = await paged(`repos/${repo}/actions/runs?head_sha=${encodeURIComponent(ref)}`, signal, "workflow_runs");
      return textResult(bounded(`${section("check_runs", checkData, 24_000)}\n\n${section("workflow_runs", workflowData, 24_000)}`), { ref, check_runs: pageMetadata(checkData), workflow_runs: pageMetadata(workflowData) });
    },
  });

  pi.registerTool({
    name: "get_workflow_run_logs",
    label: "Get workflow run logs",
    description: "Get workflow logs. The last 50 KB / 2000 lines are returned and details report truncation.",
    promptSnippet: "Read GitHub Actions workflow logs",
    parameters: Type.Object({ run_id: Type.Integer({ minimum: 1 }) }),
    async execute(_id, params, signal) {
      return textResult(await exec("gh", ["run", "view", String(params.run_id), "--log", "--repo", repository()], signal, true), { run_id: params.run_id });
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

  async function safePaths(paths: string[], ctx: ExtensionContext) {
    const root = await realpath(ctx.cwd);
    const accepted: string[] = [];
    for (const path of paths) {
      if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`Commit path must be workspace-relative without traversal: ${path}`);
      const absolute = resolve(root, path);
      const parent = await realpath(dirname(absolute));
      const fileStat = await stat(absolute).catch(() => undefined);
      if (fileStat?.isDirectory()) throw new Error(`Commit paths must identify files, not directories: ${path}`);
      const canonical = fileStat ? await realpath(absolute) : resolve(parent, absolute.slice(dirname(absolute).length + 1));
      const within = relative(root, canonical);
      if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error(`Commit path must stay within the workspace: ${path}`);
      const changed = await execRaw("git", ["status", "--porcelain", "--", path]);
      if (!changed.trim()) throw new Error(`Commit path has no workspace change: ${path}`);
      accepted.push(path);
    }
    return accepted;
  }

  async function commitChanges(message: string, paths: string[], signal: AbortSignal | undefined, ctx: ExtensionContext) {
    const selected = await safePaths(paths, ctx);
    await execRaw("git", ["config", "user.name", "github-actions[bot]"], signal);
    await execRaw("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], signal);
    await execRaw("git", ["add", "--", ...selected], signal);
    const staged = await execRaw("git", ["diff", "--cached", "--name-only", "--", ...selected], signal);
    if (!staged.trim()) throw new Error("The selected paths produced an empty commit");
    await execRaw("git", ["commit", "-m", message, "--", ...selected], signal);
  }

  const commitPaths = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Explicit workspace-relative file paths to stage and commit" });

  pi.registerTool({
    name: "post_comment", label: "Post GitHub comment", description: "Post a comment on a GitHub issue or pull request. Requires issues:write or pull-requests:write.", promptSnippet: "Post an issue or pull request comment",
    parameters: Type.Object({ number: Type.Optional(Type.Integer({ minimum: 1 })), body: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal) {
      const response = JSON.parse(await apiWithJson(`repos/${repository()}/issues/${numberOrEvent(params.number)}/comments`, "POST", { body: params.body }, signal));
      return textResult(bounded(`Posted comment: ${response.html_url}`), response);
    },
  });

  pi.registerTool({
    name: "create_pull_request_review", label: "Create pull request review", description: "Create a pull request review, optionally with inline comments.", promptSnippet: "Create a GitHub pull request review",
    parameters: Type.Object({
      pull_number: Type.Optional(Type.Integer({ minimum: 1 })), event: StringEnum(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const), body: Type.Optional(Type.String()),
      comments: Type.Optional(Type.Array(Type.Object({ path: Type.String(), line: Type.Integer({ minimum: 1 }), side: StringEnum(["LEFT", "RIGHT"] as const), body: Type.String({ minLength: 1 }), start_line: Type.Optional(Type.Integer({ minimum: 1 })), start_side: Type.Optional(StringEnum(["LEFT", "RIGHT"] as const)) }))),
    }),
    async execute(_id, params, signal) {
      const response = JSON.parse(await apiWithJson(`repos/${repository()}/pulls/${numberOrEvent(params.pull_number)}/reviews`, "POST", { event: params.event, body: params.body, comments: params.comments }, signal));
      return textResult(bounded(`Created review: ${response.html_url}`), response);
    },
  });

  pi.registerTool({
    name: "create_pull_request", label: "Create pull request", description: "Commit only explicit paths on a new branch, push it, and create a pull request.", promptSnippet: "Commit selected changes and create a GitHub pull request",
    parameters: Type.Object({ title: Type.String({ minLength: 1 }), body: Type.String(), commit_message: Type.String({ minLength: 1 }), paths: commitPaths, base: Type.Optional(Type.String()), branch: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._/-]+$" })) }),
    async execute(_id, params, signal, _update, ctx) {
      const branch = params.branch ?? `pi/run-${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
      if (branch.startsWith("-") || branch.includes("..") || branch.endsWith("/")) throw new Error("Invalid branch name");
      await execRaw("git", ["check-ref-format", "--branch", branch], signal);
      await safePaths(params.paths, ctx);
      await execRaw("git", ["switch", "--create", branch], signal);
      await commitChanges(params.commit_message, params.paths, signal, ctx);
      await execRaw("git", ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], signal);
      const args = ["pr", "create", "--repo", repository(), "--head", branch, "--title", params.title, "--body", params.body];
      if (params.base) args.push("--base", params.base);
      const url = (await execRaw("gh", args, signal)).trim();
      return textResult(bounded(`Created pull request: ${url}`), { url, branch, paths: params.paths });
    },
  });

  pi.registerTool({
    name: "update_pull_request", label: "Update pull request", description: "Commit only explicit paths and push them to an existing same-repository pull request.", promptSnippet: "Commit selected changes and update a GitHub pull request",
    parameters: Type.Object({ pull_number: Type.Optional(Type.Integer({ minimum: 1 })), commit_message: Type.String({ minLength: 1 }), paths: commitPaths, title: Type.Optional(Type.String({ minLength: 1 })), body: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      const repo = repository();
      const number = numberOrEvent(params.pull_number);
      const pull = JSON.parse(await ghApi(`repos/${repo}/pulls/${number}`, signal));
      if (pull.head?.repo?.full_name !== repo) throw new Error("Updating pull requests from forks is not supported");
      const currentBranch = (await execRaw("git", ["branch", "--show-current"], signal)).trim();
      if (currentBranch !== pull.head.ref) throw new Error(`Current branch ${currentBranch || "(detached)"} does not match pull request branch ${pull.head.ref}`);
      await commitChanges(params.commit_message, params.paths, signal, ctx);
      await execRaw("git", ["push", "origin", `HEAD:refs/heads/${pull.head.ref}`], signal);
      if (params.title !== undefined || params.body !== undefined) {
        const body: Record<string, string> = {};
        if (params.title !== undefined) body.title = params.title;
        if (params.body !== undefined) body.body = params.body;
        await apiWithJson(`repos/${repo}/pulls/${number}`, "PATCH", body, signal);
      }
      return textResult(bounded(`Updated pull request: ${pull.html_url}`), { url: pull.html_url, branch: pull.head.ref, paths: params.paths });
    },
  });
}
