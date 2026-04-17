import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { requireRole } from '@/lib/auth/helpers';

function getDevCommand(): string {
  const agent = process.env.npm_config_user_agent ?? '';
  if (agent.includes('pnpm')) return 'pnpm dev';
  if (agent.includes('yarn')) return 'yarn dev';
  if (agent.includes('bun')) return 'bun run dev';
  return 'npm run dev';
}

function scheduleRestart() {
  const cmd = getDevCommand();
  spawn('sh', ['-lc', `sleep 1; ${cmd} > /tmp/openmaic-dev.log 2>&1`], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
  }).unref();

  setTimeout(() => {
    process.exit(0);
  }, 500);
}

export async function POST(_req: NextRequest) {
  try {
    await requireRole('ADMIN');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'This endpoint is only available in development' },
      { status: 403 },
    );
  }

  const root = process.cwd();
  await rm(path.join(root, '.next', 'cache'), { recursive: true, force: true });
  await rm(path.join(root, '.next', 'static'), { recursive: true, force: true });

  scheduleRestart();
  return NextResponse.json({ success: true, message: 'Bundler cache cleared and restart scheduled' });
}
