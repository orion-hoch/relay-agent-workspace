import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Load the certificate path before creating the Node process that uses TLS.
loadEnvFile(process.argv[2] || '.env.device');
if (!process.env.SHOAL_DEVICE_TOKEN || !process.env.BUZZ_API)
  throw new Error('Save the paired device settings in .env.device first.');
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('../runner/terminal.mjs', import.meta.url))],
  { stdio: 'inherit', env: process.env },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
