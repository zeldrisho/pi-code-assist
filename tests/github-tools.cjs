const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
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
if [[ "$1" == api ]]; then
  endpoint="$2"
  method=GET
  input=
  diff=false
  args=("$@")
  for ((i=2; i<\${#args[@]}; i++)); do
    case "\${args[i]}" in
      --method) method="\${args[i+1]}"; ((i+=1)) ;;
      --input) input="\${args[i+1]}"; ((i+=1)) ;;
      *application/vnd.github.diff*) diff=true ;;
    esac
  done
  if [[ -n "$input" ]]; then
    mode="$(stat -c %a "$input")"
    node - "$REQUEST_LOG" "$method" "$endpoint" "$mode" "$input" <<'NODE'
const fs = require("node:fs");
const [, , target, method, endpoint, mode, file] = process.argv;
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
fs.appendFileSync(target, JSON.stringify({ method, endpoint, mode, file, payload }) + "\\n");
NODE
    [[ "\${FAKE_SLOW_WRITE:-}" == 1 ]] && sleep 30
    [[ "\${FAKE_WRITE_FAIL:-}" == 1 ]] && exit 7
  fi
  if [[ "$diff" == true ]]; then
    bytes="\${FAKE_DIFF_BYTES:-20}"
    if (( bytes >= 8 )); then printf HEAD; head -c "$((bytes - 8))" /dev/zero | tr '\\0' x; printf TAIL
    else head -c "$bytes" /dev/zero | tr '\\0' x
    fi
    exit 0
  fi
  case "$method $endpoint" in
    "GET repos/example/repository/issues/7") printf '{"number":7,"pull_request":{}}' ;;
    "GET repos/example/repository/issues/7/comments?per_page=100&page=1"|"GET repos/example/repository/issues/7/comments?per_page=100&page=2"|"GET repos/example/repository/issues/7/comments?per_page=100&page=3"|"GET repos/example/repository/issues/7/comments?per_page=100&page=4"|"GET repos/example/repository/issues/7/comments?per_page=100&page=5") node -e 'const n=process.env.FAKE_LARGE==="1"?100:1; console.log(JSON.stringify(Array.from({length:n},(_,i)=>({id:i,body:"comment"}))))' ;;
    "GET repos/example/repository/pulls/7/reviews?per_page=100&page=1") printf '[{"id":1}]' ;;
    "GET repos/example/repository/pulls/7/comments?per_page=100&page=1") printf '[{"id":2}]' ;;
    "GET repos/example/repository/pulls/7") if [[ -n "\${FAKE_PULL:-}" ]]; then printf '%s' "$FAKE_PULL"; else printf '%s' '{"head":{"sha":"abc","ref":"feature","repo":{"full_name":"example/repository"}},"html_url":"https://example/pr/7"}'; fi ;;
    "GET repos/example/repository/commits/abc/check-runs?per_page=100&page=1"|"GET repos/example/repository/commits/abc/check-runs?per_page=100&page=2"|"GET repos/example/repository/commits/abc/check-runs?per_page=100&page=3"|"GET repos/example/repository/commits/abc/check-runs?per_page=100&page=4"|"GET repos/example/repository/commits/abc/check-runs?per_page=100&page=5") printf '{"total_count":101,"check_runs":[{"id":1}]}' ;;
    "GET repos/example/repository/actions/runs?head_sha=abc&per_page=100&page=1") printf '{"total_count":1,"workflow_runs":[{"id":2}]}' ;;
    "POST repos/example/repository/issues/7/comments") [[ "\${FAKE_MALFORMED_WRITE:-}" == comment ]] && printf '{}' || printf '{"html_url":"https://example/comment"}' ;;
    "POST repos/example/repository/pulls/7/reviews") [[ "\${FAKE_MALFORMED_WRITE:-}" == review ]] && printf '{}' || printf '{"html_url":"https://example/review"}' ;;
    "POST repos/example/repository/pulls") [[ "\${FAKE_MALFORMED_WRITE:-}" == create ]] && printf '{}' || printf '{"html_url":"https://example/pr/8"}' ;;
    "PATCH repos/example/repository/pulls/7") [[ "\${FAKE_MALFORMED_WRITE:-}" == update ]] && printf '{}' || printf '{"html_url":"https://example/pr/7"}' ;;
    *) printf 'unexpected request: %s %s\\n' "$method" "$endpoint" >&2; exit 9 ;;
  esac
elif [[ "$1 $2" == "run view" ]]; then
  [[ "\${FAKE_SLOW_LOG:-}" == 1 ]] && sleep 30
  bytes="\${FAKE_LOG_BYTES:-20}"
  if (( bytes >= 8 )); then printf HEAD; head -c "$((bytes - 8))" /dev/zero | tr '\\0' L; printf TAIL
  else head -c "$bytes" /dev/zero | tr '\\0' L
  fi
else
  exit 2
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
  const fake = { registerTool(tool) { tools.set(tool.name, tool); } };
  createJiti(__filename)("./github-tools.ts").default(fake);
  return tools;
}

async function call(tools, name, params, ctx = { cwd: workspace }, signal) {
  return tools.get(name).execute("id", params, signal, undefined, ctx);
}
function requests() {
  const content = existsSync(requestLog) ? readFileSync(requestLog, "utf8").trim() : "";
  return content ? content.split("\n").map(line => JSON.parse(line)) : [];
}
function assertRequest(request, method, endpoint, payload) {
  assert.equal(request.method, method);
  assert.equal(request.endpoint, endpoint);
  assert.equal(request.mode, "600");
  assert.deepEqual(request.payload, payload);
  assert.equal(existsSync(request.file), false, "request file must be cleaned up");
}

(async () => {
  assert.equal(api("none").size, 0);
  const read = api("read");
  assert.deepEqual([...read.keys()], ["get_issue_or_pr_thread", "get_pr_diff", "get_ci_status", "get_workflow_run_logs"]);
  const write = api("write");
  assert.deepEqual([...write.keys()], [...read.keys(), "post_comment", "create_pull_request_review", "create_pull_request", "update_pull_request"]);

  let result = await call(read, "get_issue_or_pr_thread", { number: 7 });
  assert.match(result.content[0].text, /review_comments/);
  result = await call(read, "get_pr_diff", { pull_number: 7 });
  assert.equal(result.details.pull_number, 7);
  result = await call(read, "get_ci_status", { pull_number: 7 });
  assert.equal(result.details.check_runs.truncated, true);
  result = await call(read, "get_workflow_run_logs", { run_id: 42 });
  assert.equal(result.details.run_id, 42);

  process.env.FAKE_DIFF_BYTES = "5000000";
  result = await call(read, "get_pr_diff", { pull_number: 7 });
  assert.equal(result.details.truncated, true);
  assert.ok(result.details.returned_bytes <= 50000);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50000);
  assert.ok(result.content[0].text.split("\n").length <= 2000);
  assert.equal(result.details.total_bytes, 5000000);
  assert.match(result.content[0].text, /^HEADx/, "diffs retain their head");
  delete process.env.FAKE_DIFF_BYTES;
  process.env.FAKE_LOG_BYTES = "5000000";
  result = await call(read, "get_workflow_run_logs", { run_id: 42 });
  assert.equal(result.details.truncated, true);
  assert.ok(result.details.returned_bytes <= 50000);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50000);
  assert.ok(result.content[0].text.split("\n").length <= 2000);
  assert.equal(result.details.total_bytes, 5000000);
  assert.match(result.content[0].text, /TAIL\n\n\[Output truncated:/, "logs retain their tail");
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
  process.env.FAKE_SLOW_LOG = "1";
  const controller = new AbortController();
  const cancelled = call(read, "get_workflow_run_logs", { run_id: 42 }, undefined, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(cancelled, /cancelled/);
  delete process.env.FAKE_SLOW_LOG;

  result = await call(write, "post_comment", { number: 7, body: "hello" });
  assert.match(result.content[0].text, /https:\/\/example\/comment/);
  result = await call(write, "create_pull_request_review", { pull_number: 7, event: "COMMENT", body: "review" });
  assert.match(result.content[0].text, /https:\/\/example\/review/);
  let recorded = requests();
  assertRequest(recorded[0], "POST", "repos/example/repository/issues/7/comments", { body: "hello" });
  assertRequest(recorded[1], "POST", "repos/example/repository/pulls/7/reviews", { event: "COMMENT", body: "review" });

  for (const [kind, tool, params] of [
    ["comment", "post_comment", { number: 7, body: "bad" }],
    ["review", "create_pull_request_review", { pull_number: 7, event: "COMMENT" }],
  ]) {
    process.env.FAKE_MALFORMED_WRITE = kind;
    await assert.rejects(call(write, tool, params), /did not contain an html_url/);
  }
  delete process.env.FAKE_MALFORMED_WRITE;
  process.env.FAKE_WRITE_FAIL = "1";
  await assert.rejects(call(write, "post_comment", { number: 7, body: "fail" }));
  assert.equal(existsSync(requests().at(-1).file), false);
  delete process.env.FAKE_WRITE_FAIL;
  process.env.FAKE_SLOW_WRITE = "1";
  const writeController = new AbortController();
  const cancelledWrite = call(write, "post_comment", { number: 7, body: "cancel" }, undefined, writeController.signal);
  setTimeout(() => writeController.abort(), 100);
  await assert.rejects(cancelledWrite, /cancelled/);
  assert.equal(existsSync(requests().at(-1).file), false);
  delete process.env.FAKE_SLOW_WRITE;

  result = await call(write, "create_pull_request", { title: "Title", body: "Body", commit_message: "commit", paths: ["changed.txt"], base: "main", branch: "pi/test" });
  assert.match(result.content[0].text, /https:\/\/example\/pr\/8/);
  assertRequest(requests().at(-1), "POST", "repos/example/repository/pulls", { title: "Title", body: "Body", head: "pi/test", base: "main" });
  process.env.FAKE_MALFORMED_WRITE = "create";
  await assert.rejects(call(write, "create_pull_request", { title: "Bad", body: "", commit_message: "bad", paths: ["changed.txt"], branch: "pi/bad" }), /did not contain an html_url/);
  delete process.env.FAKE_MALFORMED_WRITE;
  await assert.rejects(call(write, "create_pull_request", { title: "x", body: "", commit_message: "x", paths: ["../secret"], branch: "pi/test2" }), /without traversal/);
  await assert.rejects(call(write, "create_pull_request", { title: "x", body: "", commit_message: "x", paths: ["."], branch: "pi/test2" }), /files, not directories/);
  await assert.rejects(call(write, "create_pull_request", { title: "x", body: "", commit_message: "x", paths: ["outside-link"], branch: "pi/test2" }), /stay within/);
  await assert.rejects(call(write, "create_pull_request", { title: "x", body: "", commit_message: "x", paths: ["changed.txt"], branch: "bad..branch" }), /Invalid branch/);

  result = await call(write, "update_pull_request", { pull_number: 7, commit_message: "update", paths: ["changed.txt"], title: "New title", body: "New body" });
  assert.match(result.content[0].text, /https:\/\/example\/pr\/7/);
  assertRequest(requests().at(-1), "PATCH", "repos/example/repository/pulls/7", { title: "New title", body: "New body" });
  process.env.FAKE_MALFORMED_WRITE = "update";
  await assert.rejects(call(write, "update_pull_request", { pull_number: 7, commit_message: "update", paths: ["changed.txt"], title: "bad" }), /did not contain an html_url/);
  delete process.env.FAKE_MALFORMED_WRITE;
  process.env.FAKE_BRANCH = "other";
  await assert.rejects(call(write, "update_pull_request", { pull_number: 7, commit_message: "x", paths: ["changed.txt"] }), /does not match/);
  delete process.env.FAKE_BRANCH;
  process.env.FAKE_PULL = '{"head":{"ref":"feature","repo":{"full_name":"fork/repo"}},"html_url":"https://example/pr/7"}';
  await assert.rejects(call(write, "update_pull_request", { pull_number: 7, commit_message: "x", paths: ["changed.txt"] }), /forks/);

  console.log("GitHub extension tests passed.");
})().finally(() => {
  if (process.env.CI === "true") rmSync(root, { recursive: true, force: true });
  else if (spawnSync("sh", ["-c", "command -v gomi"], { stdio: "ignore" }).status === 0) execFileSync("gomi", [root]);
  else console.error(`Extension harness files left at ${root} (install gomi to enable cleanup).`);
});
