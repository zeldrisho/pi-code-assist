export const GITHUB_READ_TOOLS = Object.freeze([
  'get_issue_or_pr_thread',
  'get_pr_diff',
  'get_ci_status',
  'get_workflow_run_logs',
] as const);

export const GITHUB_WRITE_TOOLS = Object.freeze([
  'post_comment',
  'create_pull_request_review',
  'create_pull_request',
  'update_pull_request',
] as const);

export type GitHubReadTool = (typeof GITHUB_READ_TOOLS)[number];
export type GitHubWriteTool = (typeof GITHUB_WRITE_TOOLS)[number];
export type GitHubTool = GitHubReadTool | GitHubWriteTool;
