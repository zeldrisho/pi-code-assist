// @ts-nocheck -- This integration harness deliberately exercises dynamically registered Pi tools.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'vite-plus/test';
import githubToolsExtension from '../extensions/github/index.ts';
const root = mkdtempSync(join(tmpdir(), 'pi-agent-extension-test-'));
const bin = join(root, 'bin');
const workspace = join(root, 'workspace');
mkdirSync(bin);
mkdirSync(workspace);
const log = join(root, 'commands.log');
const requestLog = join(root, 'request.log');
writeFileSync(join(workspace, 'changed.txt'), 'changed\n');
writeFileSync(join(root, 'outside.txt'), 'secret\n');
symlinkSync(join(root, 'outside.txt'), join(workspace, 'outside-link'));

const fakeCli = `#!/usr/bin/env python3
import json
import os
import pathlib
import stat
import sys
import time

args = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
with open(os.environ["COMMAND_LOG"], "ab") as stream:
    stream.write(name.encode() + b"\\0")
    for argument in args:
        stream.write(argument.encode() + b"\\0")

if name == "git":
    command = " ".join(args[:2])
    if command == "status --porcelain": print(" M changed.txt")
    elif command == "diff --cached": print("changed.txt")
    elif command == "branch --show-current": print(os.environ.get("FAKE_BRANCH", "feature"))
    sys.exit(0)

if args[:2] == ["run", "view"]:
    if os.environ.get("FAKE_SLOW_LOG") == "1": time.sleep(30)
    size = int(os.environ.get("FAKE_LOG_BYTES", "20"))
    content = (b"HEAD" + b"L" * max(0, size - 8) + b"TAIL") if size >= 8 else b"L" * size
    sys.stdout.buffer.write(content)
    sys.exit(0)
if not args or args[0] != "api": sys.exit(2)

endpoint = args[1]
method = "GET"
input_path = None
is_diff = False
index = 2
while index < len(args):
    if args[index] == "--method": method = args[index + 1]; index += 2; continue
    if args[index] == "--input": input_path = args[index + 1]; index += 2; continue
    if "application/vnd.github.diff" in args[index]: is_diff = True
    index += 1

if input_path:
    with open(input_path) as stream: payload = json.load(stream)
    request = {"method": method, "endpoint": endpoint, "mode": format(stat.S_IMODE(os.stat(input_path).st_mode), "o"), "file": input_path, "payload": payload}
    with open(os.environ["REQUEST_LOG"], "a") as stream: stream.write(json.dumps(request) + "\\n")
    if os.environ.get("FAKE_SLOW_WRITE") == "1": time.sleep(30)
    if os.environ.get("FAKE_WRITE_FAIL") == "1": sys.exit(7)
if is_diff:
    size = int(os.environ.get("FAKE_DIFF_BYTES", "20"))
    content = (b"HEAD" + b"x" * max(0, size - 8) + b"TAIL") if size >= 8 else b"x" * size
    sys.stdout.buffer.write(content)
    sys.exit(0)

if method == "GET" and endpoint == "repos/example/repository/issues/7": response = {"number": 7, "pull_request": {}}
elif method == "GET" and endpoint.startswith("repos/example/repository/issues/7/comments?per_page=100&page="):
    count = 100 if os.environ.get("FAKE_LARGE") == "1" else 1
    response = [{"id": item, "body": "comment"} for item in range(count)]
elif method == "GET" and endpoint == "repos/example/repository/pulls/7/reviews?per_page=100&page=1": response = [{"id": 1}]
elif method == "GET" and endpoint == "repos/example/repository/pulls/7/comments?per_page=100&page=1": response = [{"id": 2}]
elif method == "GET" and endpoint == "repos/example/repository/pulls/7": response = json.loads(os.environ.get("FAKE_PULL", '{"head":{"sha":"abc","ref":"feature","repo":{"full_name":"example/repository"}},"html_url":"https://example/pr/7"}'))
elif method == "GET" and endpoint.startswith("repos/example/repository/commits/abc/check-runs?per_page=100&page="): response = {"total_count": 101, "check_runs": [{"id": 1}]}
elif method == "GET" and endpoint == "repos/example/repository/actions/runs?head_sha=abc&per_page=100&page=1": response = {"total_count": 1, "workflow_runs": [{"id": 2}]}
elif method == "POST" and endpoint == "repos/example/repository/issues/7/comments": response = {} if os.environ.get("FAKE_MALFORMED_WRITE") == "comment" else {"html_url": "https://example/comment"}
elif method == "POST" and endpoint == "repos/example/repository/pulls/7/reviews": response = {} if os.environ.get("FAKE_MALFORMED_WRITE") == "review" else {"html_url": "https://example/review"}
elif method == "POST" and endpoint == "repos/example/repository/pulls": response = {} if os.environ.get("FAKE_MALFORMED_WRITE") == "create" else {"html_url": "https://example/pr/8"}
elif method == "PATCH" and endpoint == "repos/example/repository/pulls/7": response = {} if os.environ.get("FAKE_MALFORMED_WRITE") == "update" else {"html_url": "https://example/pr/7"}
else:
    print(f"unexpected request: {method} {endpoint}", file=sys.stderr)
    sys.exit(9)
print(json.dumps(response), end="")
`;
for (const name of ['gh', 'git']) {
  writeFileSync(join(bin, name), fakeCli);
  chmodSync(join(bin, name), 0o755);
}
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.COMMAND_LOG = log;
process.env.REQUEST_LOG = requestLog;
process.env.GITHUB_REPOSITORY = 'example/repository';
process.chdir(workspace);

function api(mode) {
  const tools = new Map();
  process.env.PI_AGENT_GITHUB_TOOLS = mode;
  const fake = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  githubToolsExtension(fake as never);
  return tools;
}

async function call(tools, name, params, ctx = { cwd: workspace }, signal) {
  return tools.get(name).execute('id', params, signal, undefined, ctx);
}
function requests() {
  const content = existsSync(requestLog) ? readFileSync(requestLog, 'utf8').trim() : '';
  return content ? content.split('\n').map((line) => JSON.parse(line)) : [];
}
function assertRequest(request, method, endpoint, payload) {
  assert.equal(request.method, method);
  assert.equal(request.endpoint, endpoint);
  assert.equal(request.mode, '600');
  assert.deepEqual(request.payload, payload);
  assert.equal(existsSync(request.file), false, 'request file must be cleaned up');
}

test('GitHub extension behavior and security boundaries', async () => {
  assert.equal(api('none').size, 0);
  const read = api('read');
  assert.deepEqual(
    [...read.keys()],
    ['get_issue_or_pr_thread', 'get_pr_diff', 'get_ci_status', 'get_workflow_run_logs'],
  );
  const write = api('write');
  assert.deepEqual(
    [...write.keys()],
    [
      ...read.keys(),
      'post_comment',
      'create_pull_request_review',
      'create_pull_request',
      'update_pull_request',
    ],
  );

  let result = await call(read, 'get_issue_or_pr_thread', { number: 7 });
  assert.match(result.content[0].text, /review_comments/);
  result = await call(read, 'get_pr_diff', { pull_number: 7 });
  assert.equal(result.details.pull_number, 7);
  result = await call(read, 'get_ci_status', { pull_number: 7 });
  assert.equal(result.details.check_runs.truncated, true);
  result = await call(read, 'get_workflow_run_logs', { run_id: 42 });
  assert.equal(result.details.run_id, 42);

  process.env.FAKE_DIFF_BYTES = '5000000';
  result = await call(read, 'get_pr_diff', { pull_number: 7 });
  assert.equal(result.details.truncated, true);
  assert.ok(result.details.returned_bytes <= 50000);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50000);
  assert.ok(result.content[0].text.split('\n').length <= 2000);
  assert.equal(result.details.total_bytes, 5000000);
  assert.match(result.content[0].text, /^HEADx/, 'diffs retain their head');
  delete process.env.FAKE_DIFF_BYTES;
  process.env.FAKE_LOG_BYTES = '5000000';
  result = await call(read, 'get_workflow_run_logs', { run_id: 42 });
  assert.equal(result.details.truncated, true);
  assert.ok(result.details.returned_bytes <= 50000);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50000);
  assert.ok(result.content[0].text.split('\n').length <= 2000);
  assert.equal(result.details.total_bytes, 5000000);
  assert.match(result.content[0].text, /TAIL\n\n\[Output truncated:/, 'logs retain their tail');
  delete process.env.FAKE_LOG_BYTES;
  process.env.FAKE_LARGE = '1';
  result = await call(read, 'get_issue_or_pr_thread', { number: 7 });
  assert.equal(result.details.comments.truncated, true);
  assert.match(result.details.comments.continuation, /page=6/);
  delete process.env.FAKE_LARGE;

  const event = join(root, 'event.json');
  writeFileSync(event, 'not-json');
  process.env.GITHUB_EVENT_PATH = event;
  await assert.rejects(call(read, 'get_pr_diff', {}), /event payload was missing or malformed/);
  writeFileSync(event, '{"pull_request":{"number":7}}');
  await call(read, 'get_pr_diff', {});
  delete process.env.GITHUB_EVENT_PATH;
  process.env.FAKE_SLOW_LOG = '1';
  const controller = new AbortController();
  const cancelled = call(
    read,
    'get_workflow_run_logs',
    { run_id: 42 },
    undefined,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(cancelled, /cancelled/);
  delete process.env.FAKE_SLOW_LOG;

  result = await call(write, 'post_comment', { number: 7, body: 'hello' });
  assert.match(result.content[0].text, /https:\/\/example\/comment/);
  result = await call(write, 'create_pull_request_review', {
    pull_number: 7,
    event: 'COMMENT',
    body: 'review',
  });
  assert.match(result.content[0].text, /https:\/\/example\/review/);
  let recorded = requests();
  assertRequest(recorded[0], 'POST', 'repos/example/repository/issues/7/comments', {
    body: 'hello',
  });
  assertRequest(recorded[1], 'POST', 'repos/example/repository/pulls/7/reviews', {
    event: 'COMMENT',
    body: 'review',
  });

  for (const [kind, tool, params] of [
    ['comment', 'post_comment', { number: 7, body: 'bad' }],
    ['review', 'create_pull_request_review', { pull_number: 7, event: 'COMMENT' }],
  ]) {
    process.env.FAKE_MALFORMED_WRITE = kind;
    await assert.rejects(call(write, tool, params), /did not contain an html_url/);
  }
  delete process.env.FAKE_MALFORMED_WRITE;
  process.env.FAKE_WRITE_FAIL = '1';
  await assert.rejects(call(write, 'post_comment', { number: 7, body: 'fail' }));
  assert.equal(existsSync(requests().at(-1).file), false);
  delete process.env.FAKE_WRITE_FAIL;
  process.env.FAKE_SLOW_WRITE = '1';
  const writeController = new AbortController();
  const cancelledWrite = call(
    write,
    'post_comment',
    { number: 7, body: 'cancel' },
    undefined,
    writeController.signal,
  );
  setTimeout(() => writeController.abort(), 100);
  await assert.rejects(cancelledWrite, /cancelled/);
  assert.equal(existsSync(requests().at(-1).file), false);
  delete process.env.FAKE_SLOW_WRITE;

  result = await call(write, 'create_pull_request', {
    title: 'Title',
    body: 'Body',
    commit_message: 'commit',
    paths: ['changed.txt'],
    base: 'main',
    branch: 'pi/test',
  });
  assert.match(result.content[0].text, /https:\/\/example\/pr\/8/);
  assertRequest(requests().at(-1), 'POST', 'repos/example/repository/pulls', {
    title: 'Title',
    body: 'Body',
    head: 'pi/test',
    base: 'main',
  });
  process.env.FAKE_MALFORMED_WRITE = 'create';
  await assert.rejects(
    call(write, 'create_pull_request', {
      title: 'Bad',
      body: '',
      commit_message: 'bad',
      paths: ['changed.txt'],
      branch: 'pi/bad',
    }),
    /did not contain an html_url/,
  );
  delete process.env.FAKE_MALFORMED_WRITE;
  await assert.rejects(
    call(write, 'create_pull_request', {
      title: 'x',
      body: '',
      commit_message: 'x',
      paths: ['../secret'],
      branch: 'pi/test2',
    }),
    /without traversal/,
  );
  await assert.rejects(
    call(write, 'create_pull_request', {
      title: 'x',
      body: '',
      commit_message: 'x',
      paths: ['.'],
      branch: 'pi/test2',
    }),
    /files, not directories/,
  );
  await assert.rejects(
    call(write, 'create_pull_request', {
      title: 'x',
      body: '',
      commit_message: 'x',
      paths: ['outside-link'],
      branch: 'pi/test2',
    }),
    /stay within/,
  );
  await assert.rejects(
    call(write, 'create_pull_request', {
      title: 'x',
      body: '',
      commit_message: 'x',
      paths: ['changed.txt'],
      branch: 'bad..branch',
    }),
    /Invalid branch/,
  );

  result = await call(write, 'update_pull_request', {
    pull_number: 7,
    commit_message: 'update',
    paths: ['changed.txt'],
    title: 'New title',
    body: 'New body',
  });
  assert.match(result.content[0].text, /https:\/\/example\/pr\/7/);
  assertRequest(requests().at(-1), 'PATCH', 'repos/example/repository/pulls/7', {
    title: 'New title',
    body: 'New body',
  });
  process.env.FAKE_MALFORMED_WRITE = 'update';
  await assert.rejects(
    call(write, 'update_pull_request', {
      pull_number: 7,
      commit_message: 'update',
      paths: ['changed.txt'],
      title: 'bad',
    }),
    /did not contain an html_url/,
  );
  delete process.env.FAKE_MALFORMED_WRITE;
  process.env.FAKE_BRANCH = 'other';
  await assert.rejects(
    call(write, 'update_pull_request', {
      pull_number: 7,
      commit_message: 'x',
      paths: ['changed.txt'],
    }),
    /does not match/,
  );
  delete process.env.FAKE_BRANCH;
  process.env.FAKE_PULL =
    '{"head":{"ref":"feature","repo":{"full_name":"fork/repo"}},"html_url":"https://example/pr/7"}';
  await assert.rejects(
    call(write, 'update_pull_request', {
      pull_number: 7,
      commit_message: 'x',
      paths: ['changed.txt'],
    }),
    /forks/,
  );

  console.log('GitHub extension tests passed.');
});

process.on('exit', () => {
  if (process.env.CI === 'true') rmSync(root, { recursive: true, force: true });
  else if (spawnSync('gomi', ['--version'], { stdio: 'ignore' }).status === 0)
    execFileSync('gomi', [root]);
  else console.error(`Extension harness files left at ${root} (install gomi to enable cleanup).`);
});
