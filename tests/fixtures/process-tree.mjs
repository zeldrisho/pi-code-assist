import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const mode = process.argv[2];

if (mode === 'child') {
  process.on('SIGTERM', () => {
    writeFileSync(process.env.PROCESS_TEST_MARKER, 'terminated');
    process.exit(0);
  });
} else if (mode === 'parent') {
  spawn(process.execPath, [import.meta.filename, 'child'], {
    env: process.env,
    stdio: 'ignore',
  });
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
} else if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {});
} else {
  throw new Error(`Unsupported process fixture mode: ${mode}`);
}

setInterval(() => {}, 1_000);
