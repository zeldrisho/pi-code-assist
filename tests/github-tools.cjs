const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn, execFileSync, spawnSync } = require("node:child_process");
const { createJiti } = require("./node_modules/jiti/lib/jiti.cjs");

const root = mkdtempSync(join(tmpdir(), "pi-agent-extension-test-"));
const bin = join(root, "bin");
const workspace = join(root, "workspace");
mkdirSync(bin); mkdirSync(workspace);
const log = join(root, "commands.log");
const requestLog = join(root, "request.log");
writeFileSync(join(workspace, "changed.txt"), "changed\n");
writeFileSync(join(root, "outside.txt"), "secret\n");
symlinkSync(join(root, "outside.txt"), join(workspace, "outside-link"));

const gh = `#!/usr/bin/env bash
set -euo pipefail
{ printf 'gh\\0'; printf '%s\\0' "$@"; } >> "$COMMAND_LOG"
original=("$@")
if [[ " $* " == *" --input "* ]]; then
  while (( $# )); do [[ "$1" == --input ]] && { shift; printf '%s %s\\n' "$1" "$(stat -c %a "$1")" >> "$REQUEST_LOG"; [[ "\${FAKE_WRITE_FAIL:-}" == 1 ]] && exit 7; break; }; shift; done
fi
set -- "\${original[@]}"
if [[ "$1" == api ]]; then
  path="$2"
  if [[ " $* " == *" application/vnd.github.diff "* ]]; then
    printf 'diff --git a/a b/a\\n%s' "$(head -c "\${FAKE_DIFF_BYTES:-10}" /dev/zero | tr '\\0' x)"
    exit 0
  fi
  case "$path" in
    repos/example/repository/issues/7) printf '{"number":7,"pull_request":{}}' ;;
    *issues/7/comments*) node -e 'const n=process.env.FAKE_LARGE==="1"?100:1; console.log(JSON.stringify(Array.from({length:n},(_,i)=>({id:i,body:"comment"}))))' ;;
    *pulls/7/reviews*) printf '[{"id":1}]' ;;
    *pulls/7/comments*) printf '[{"id":2}]' ;;
    repos/example/repository/pulls/7) if [[ -n "\${FAKE_PULL:-}" ]]; then printf '%s' "$FAKE_PULL"; else printf '%s' '{"head":{"sha":"abc","ref":"feature","repo":{"full_name":"example/repository"}},"html_url":"https://example/pr/7"}'; fi ;;
    *check-runs*) printf '{"total_count":101,"check_runs":[{"id":1}]}' ;;
    *actions/runs*) printf '{"total_count":1,"workflow_runs":[{"id":2}]}' ;;
    *pulls/7/reviews) printf '{"html_url":"https://example/review"}' ;;
    *issues/7/comments) printf '{"html_url":"https://example/comment"}' ;;
    *pulls/7) printf '{"html_url":"https://example/pr/7"}' ;;
    *) printf '{}' ;;
  esac
elif [[ "$1 $2" == "run view" ]]; then
  head -c "\${FAKE_LOG_BYTES:-20}" /dev/zero | tr '\\0' L
elif [[ "$1 $2" == "pr create" ]]; then printf 'https://example/pr/8\\n'
else exit 2
fi
`;
const git = `#!/usr/bin/env bash
set -euo pipefail
{ printf 'git\\0'; printf '%s\\0' "$@"; } >> "$COMMAND_LOG"
case "$1 $2" in
  "status --porcelain") printf ' M changed.txt\\n' ;;
  "diff --cached") printf 'changed.txt\\n' ;;
  "branch --show-current") printf '%s\\n' "\${FAKE_BRANCH:-feature}" ;;
  *) : ;;
esac
`;
for (const [name, body] of [["gh", gh], ["git", git]]) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.COMMAND_LOG = log;
process.env.REQUEST_LOG = requestLog;
process.env.GITHUB_REPOSITORY = "example/repository";
process.chdir(workspace);

function api(mode) {
  const tools = new Map();
  process.env.PI_AGENT_GITHUB_TOOLS = mode;
  const fake = {
    registerTool(tool) { tools.set(tool.name, tool); },
    exec(command, args, options = {}) {
      assert.equal(options.timeout, 120000);
      return new Promise((resolve, reject) => {
        if (process.env.FAKE_TIMEOUT === "1") return resolve({ code: 124, stdout: "", stderr: "timed out", killed: true });
        const child = spawn(command, args, { env: process.env });
        let stdout = "", stderr = "";
        child.stdout.on("data", value => stdout += value);
        child.stderr.on("data", value => stderr += value);
        child.on("error", reject);
        child.on("close", code => resolve({ code, stdout, stderr, killed: false }));
        options.signal?.addEventListener("abort", () => child.kill(), { once: true });
      });
    },
  };
  const jiti = createJiti(__filename);
  jiti("./github-tools.ts").default(fake);
  return tools;
}

async function call(tools, name, params, ctx = { cwd: workspace }) {
  return tools.get(name).execute("id", params, undefined, undefined, ctx);
}

(async () => {
  process.env.PI_AGENT_GITHUB_TOOLS = "none";
  assert.equal(api("none").size, 0);
  const read = api("read");
  assert.deepEqual([...read.keys()], ["get_issue_or_pr_thread", "get_pr_diff", "get_ci_status", "get_workflow_run_logs"]);
  const write = api("write");
  assert.equal(write.size, 8);

  let result = await call(read, "get_issue_or_pr_thread", { number: 7 });
  assert.match(result.content[0].text, /review_comments/);
  result = await call(read, "get_pr_diff", { pull_number: 7 });
  assert.equal(result.details.pull_number, 7);
  result = await call(read, "get_ci_status", { pull_number: 7 });
  assert.equal(result.details.check_runs.truncated, true);
  result = await call(read, "get_workflow_run_logs", { run_id: 42 });
  assert.equal(result.details.run_id, 42);

  process.env.FAKE_DIFF_BYTES = "60000";
  result = await call(read, "get_pr_diff", { pull_number: 7 });
  assert.equal(result.details.truncated, true);
  delete process.env.FAKE_DIFF_BYTES;
  process.env.FAKE_LOG_BYTES = "60000";
  result = await call(read, "get_workflow_run_logs", { run_id: 42 });
  assert.equal(result.details.truncated, true);
  delete process.env.FAKE_LOG_BYTES;
  process.env.FAKE_LARGE = "1";
  result = await call(read, "get_issue_or_pr_thread", { number: 7 });
  assert.equal(result.details.comments.truncated, true);
  assert.match(result.details.comments.continuation, /page=6/);
  delete process.env.FAKE_LARGE;

  const event = join(root, "event.json");
  writeFileSync(event, "not-json"); process.env.GITHUB_EVENT_PATH = event;
  await assert.rejects(call(read, "get_pr_diff", {}), /event payload was missing or malformed/);
  writeFileSync(event, '{"pull_request":{"number":7}}');
  await call(read, "get_pr_diff", {});
  delete process.env.GITHUB_EVENT_PATH;
  process.env.FAKE_TIMEOUT = "1";
  await assert.rejects(call(read, "get_pr_diff", { pull_number: 7 }), /timed out/);
  delete process.env.FAKE_TIMEOUT;

  await call(write, "post_comment", { number: 7, body: "hello" });
  await call(write, "create_pull_request_review", { pull_number: 7, event: "COMMENT", body: "review" });
  const requests = readFileSync(requestLog, "utf8").trim().split("\n");
  assert.ok(requests.every(line => line.endsWith(" 600")), "request bodies must have mode 600");
  assert.ok(requests.every(line => !existsSync(line.split(" ")[0])), "request files must be cleaned up");
  process.env.FAKE_WRITE_FAIL = "1";
  await assert.rejects(call(write, "post_comment", { number: 7, body: "fail" }));
  const failedPath = readFileSync(requestLog, "utf8").trim().split("\n").at(-1).split(" ")[0];
  assert.equal(existsSync(failedPath), false);
  delete process.env.FAKE_WRITE_FAIL;

  await call(write, "create_pull_request", { title: "Title", body: "Body", commit_message: "commit", paths: ["changed.txt"], branch: "pi/test" });
  await assert.rejects(call(write, "create_pull_request", { title: "x", body: "", commit_message: "x", paths: ["../secret"], branch: "pi/test2" }), /without traversal/);
  await assert.rejects(call(write, "create_pull_request", { title: "x", body: "", commit_message: "x", paths: ["."], branch: "pi/test2" }), /files, not directories/);
  await assert.rejects(call(write, "create_pull_request", { title: "x", body: "", commit_message: "x", paths: ["outside-link"], branch: "pi/test2" }), /stay within/);
  await assert.rejects(call(write, "create_pull_request", { title: "x", body: "", commit_message: "x", paths: ["changed.txt"], branch: "bad..branch" }), /Invalid branch/);
  await call(write, "update_pull_request", { pull_number: 7, commit_message: "update", paths: ["changed.txt"] });
  process.env.FAKE_BRANCH = "other";
  await assert.rejects(call(write, "update_pull_request", { pull_number: 7, commit_message: "x", paths: ["changed.txt"] }), /does not match/);
  delete process.env.FAKE_BRANCH;
  process.env.FAKE_PULL = '{"head":{"ref":"feature","repo":{"full_name":"fork/repo"}},"html_url":"x"}';
  await assert.rejects(call(write, "update_pull_request", { pull_number: 7, commit_message: "x", paths: ["changed.txt"] }), /forks/);

  console.log("GitHub extension tests passed.");
})().finally(() => {
  if (process.env.CI === "true") rmSync(root, { recursive: true, force: true });
  else if (spawnSync("sh", ["-c", "command -v gomi"], { stdio: "ignore" }).status === 0) execFileSync("gomi", [root]);
  else console.error(`Extension harness files left at ${root} (install gomi to enable cleanup).`);
});
