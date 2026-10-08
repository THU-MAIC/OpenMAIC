import { spawn } from 'node:child_process';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const build = spawn(command, ['build'], {
  stdio: 'inherit',
  env: { ...process.env, NEXT_TURBOPACK_USE_WORKER: '0' },
});

build.on('exit', (code, signal) => {
  if (code !== 0) process.exit(code ?? 1);
  if (signal) process.kill(process.pid, signal);
  const prepare = spawn(process.execPath, ['scripts/prepare-desktop-runtime.mjs'], {
    stdio: 'inherit',
    env: process.env,
  });
  prepare.on('exit', (prepareCode) => process.exit(prepareCode ?? 1));
});
