import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { request } from 'node:http';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const electron = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const publicSkillsDirs = JSON.stringify([
  `${homedir()}/.codex/skills`,
  `${homedir()}/.agents/skills`,
]);
const desktopSyncToken = randomBytes(32).toString('hex');
const desktopEnv = {
  ...process.env,
  OPENMAIC_DESKTOP_SYNC_ENABLED: '1',
  OPENMAIC_DESKTOP_SYNC_TOKEN: desktopSyncToken,
  OPENMAIC_PUBLIC_SKILLS_DIRS: publicSkillsDirs,
};

function waitForServer(url, timeoutMs = 120_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = request(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`Timed out waiting for ${url}`));
        else setTimeout(poll, 250);
      });
      req.end();
    };
    poll();
  });
}

const next = spawn(command, ['dev'], {
  stdio: 'inherit',
  env: desktopEnv,
});

try {
  await waitForServer('http://127.0.0.1:3000');
  const desktop = spawn(electron, ['desktop/main.cjs', '--dev'], {
    stdio: 'inherit',
    env: desktopEnv,
  });
  const stop = (code) => {
    next.kill('SIGTERM');
    if (!desktop.killed) desktop.kill('SIGTERM');
    process.exit(typeof code === 'number' ? code : 0);
  };
  desktop.on('exit', (code) => stop(code));
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
} catch (error) {
  next.kill('SIGTERM');
  console.error(error);
  process.exit(1);
}
