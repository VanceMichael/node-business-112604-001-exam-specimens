import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test', 'test/business.test.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'inherit',
  env: process.env
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
