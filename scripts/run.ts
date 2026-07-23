import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installPi, type InstalledPi } from './installation.ts';
import { maskInputSecrets, parseActionConfig, type ActionConfig } from './inputs.ts';
import { invokePi, type InvocationResult } from './invocation.ts';
import { publishResponse, type PublishedResponse } from './outputs.ts';

export interface RuntimeHooks {
  readonly parse?: (env: NodeJS.ProcessEnv) => Promise<ActionConfig>;
  readonly install?: (config: ActionConfig, env: NodeJS.ProcessEnv) => Promise<InstalledPi>;
  readonly invoke?: (
    config: ActionConfig,
    installed: InstalledPi,
    env: NodeJS.ProcessEnv,
  ) => Promise<InvocationResult>;
  readonly publish?: (githubOutput: string, responsePath: string) => Promise<PublishedResponse>;
}

export async function runAction(
  env: NodeJS.ProcessEnv = process.env,
  hooks: RuntimeHooks = {},
): Promise<void> {
  maskInputSecrets(env);
  const config = hooks.parse ? await hooks.parse(env) : await parseActionConfig(env, true);
  const installed = await (hooks.install ?? installPi)(config, env);
  console.log(`Pi ${installed.version} installation completed.`);
  console.log(`Starting Pi/model invocation (${config.provider}/${config.model})...`);
  const invocation = await (hooks.invoke ?? invokePi)(config, installed, env);
  const publication = await (hooks.publish ?? publishResponse)(
    config.githubOutput,
    invocation.responseFile,
  );

  if (publication.empty) {
    if (invocation.status !== 0)
      throw new Error(`Pi exited with status ${invocation.status} without producing a response`);
    throw new Error('Pi/model invocation completed without a non-empty response');
  }
  if (invocation.status !== 0) throw new Error(`Pi exited with status ${invocation.status}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runAction().catch((error: unknown) => {
    console.error(`Pi Code Assist: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
