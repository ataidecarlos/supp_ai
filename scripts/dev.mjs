import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { buildMain } from './build.mjs';

await buildMain();
const server = await createServer({ server: { host: 'localhost' } });
await server.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, SUPPORT_DEV_URL: server.resolvedUrls.local[0] },
});
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill());
}
