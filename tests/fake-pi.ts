import { writeFile } from 'node:fs/promises';

if (process.env.PI_AGENT_TEST_HANG === 'true') {
  process.on('SIGTERM', () => {
    const marker = process.env.PI_AGENT_TEST_TERMINATED;
    void (marker ? writeFile(marker, 'SIGTERM\n') : Promise.resolve()).then(() => process.exit(0));
  });
  setInterval(() => {}, 60_000);
}

if (process.env.PI_AGENT_TEST_ARGS) {
  await writeFile(process.env.PI_AGENT_TEST_ARGS, `${JSON.stringify(process.argv.slice(2))}\n`);
}
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
if (process.env.PI_AGENT_TEST_STDIN) {
  await writeFile(process.env.PI_AGENT_TEST_STDIN, Buffer.concat(chunks));
}
console.log('integration test passed');
