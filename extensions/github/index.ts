import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GITHUB_READ_TOOLS, GITHUB_WRITE_TOOLS } from './manifest.ts';
import { registerReadTools } from './tools/read.ts';
import { registerWriteTools } from './tools/write.ts';

type Mode = 'read' | 'write';
type Register = (pi: ExtensionAPI) => void;

function registerCatalog(pi: ExtensionAPI, catalog: readonly string[], register: Register): void {
  let index = 0;
  const guarded = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== 'registerTool') return Reflect.get(target, property, receiver);
      return (tool: { name: string }) => {
        const expected = catalog[index];
        if (tool.name !== expected)
          throw new Error(
            `GitHub tool manifest mismatch: expected ${expected}, received ${tool.name}`,
          );
        index += 1;
        return target.registerTool(tool as never);
      };
    },
  });
  register(guarded);
  if (index !== catalog.length)
    throw new Error(
      `GitHub tool manifest mismatch: registered ${index} of ${catalog.length} tools`,
    );
}

export default function githubTools(pi: ExtensionAPI): void {
  const mode = process.env.PI_AGENT_GITHUB_TOOLS as Mode | undefined;
  if (mode !== 'read' && mode !== 'write') return;
  registerCatalog(pi, GITHUB_READ_TOOLS, registerReadTools);
  if (mode === 'write') registerCatalog(pi, GITHUB_WRITE_TOOLS, registerWriteTools);
}
