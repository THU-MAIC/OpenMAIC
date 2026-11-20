/**
 * The Next.js signal behaviour instrumentation.ts relies on, checked with a
 * real `next start` and a real SIGTERM against the app's own exit hold
 * (lib/server/exit-hold.ts, copied into a throwaway app):
 *
 * - Next exits as soon as its HTTP server has closed, without waiting for the
 *   app's handler, so the app's shutdown needs the hold;
 * - Next's exit goes through process.exit, so holding it keeps the process up
 *   until the app's shutdown is done, and the exit keeps Next's code;
 * - Next keeps waiting while a connection stays open, so the hold's HTTP grace
 *   is what ends the process then.
 *
 * A Next.js upgrade that changes any of these breaks the agent runner's
 * shutdown drain; this fails first.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const nextBin = path.join(root, 'node_modules/next/dist/bin/next');
const DRAIN_MS = 1500;
const HTTP_GRACE_MS = 3500;

// The app's handler as instrumentation.ts installs it: a shutdown that takes
// DRAIN_MS, with the exit held for it when HOLD_EXIT is set.
const instrumentation = `export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { holdProcessExit } = await import('./exit-hold');
  process.once('SIGTERM', () => {
    console.log('drain started');
    const shutdown = new Promise<void>((resolve) =>
      setTimeout(() => {
        console.log('drain finished');
        resolve();
      }, ${DRAIN_MS}),
    );
    if (process.env.HOLD_EXIT) {
      holdProcessExit({ shutdown, signalCode: 143, httpGraceMs: ${HTTP_GRACE_MS}, deadlineMs: 20_000 });
    }
  });
}
`;

// A response that never ends, like the workbench's event streams.
const streamRoute = `export const dynamic = 'force-dynamic';
export async function GET() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: open\\n\\n'));
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
`;

const children = new Set<ChildProcess>();
let appDir = '';

function environment(holdExit: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  delete env.NEXT_MANUAL_SIG_HANDLE;
  if (holdExit) env.HOLD_EXIT = '1';
  else delete env.HOLD_EXIT;
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Start the app, optionally open a stream, send SIGTERM, and report how the process ended. */
async function terminate(options: { holdExit: boolean; openStream?: boolean }) {
  const port = await freePort();
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    cwd: appDir,
    env: environment(options.holdExit),
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      exitCode = code;
      resolve(code);
    }),
  );
  for (let ready = false; !ready; ) {
    if (exitCode !== undefined) throw new Error(`next start exited with ${exitCode}:\n${output}`);
    ready = await fetch(`http://127.0.0.1:${port}/`).then(
      (response) => response.ok,
      () => false,
    );
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (options.openStream) {
    await new Promise<void>((resolve, reject) => {
      const stream = request(`http://127.0.0.1:${port}/stream`, (response) => {
        response.once('data', () => resolve());
        response.on('error', () => {});
      });
      stream.on('error', reject);
      stream.end();
    });
  }
  const signalledAt = Date.now();
  child.kill('SIGTERM');
  const code = await exited;
  children.delete(child);
  return { code, elapsedMs: Date.now() - signalledAt, output };
}

describe.skipIf(process.platform === 'win32')('Next.js SIGTERM handling', () => {
  beforeAll(() => {
    appDir = mkdtempSync(path.join(tmpdir(), 'openmaic-signal-contract-'));
    mkdirSync(path.join(appDir, 'app/stream'), { recursive: true });
    writeFileSync(path.join(appDir, 'package.json'), '{ "private": true }\n');
    writeFileSync(
      path.join(appDir, 'next.config.js'),
      'module.exports = { typescript: { ignoreBuildErrors: true } };\n',
    );
    writeFileSync(
      path.join(appDir, 'app/layout.jsx'),
      'export default function Layout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n',
    );
    writeFileSync(
      path.join(appDir, 'app/page.jsx'),
      'export default function Page() {\n  return <p>ok</p>;\n}\n',
    );
    writeFileSync(path.join(appDir, 'app/stream/route.js'), streamRoute);
    writeFileSync(path.join(appDir, 'instrumentation.ts'), instrumentation);
    copyFileSync(path.join(root, 'lib/server/exit-hold.ts'), path.join(appDir, 'exit-hold.ts'));
    symlinkSync(path.join(root, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
    execFileSync(process.execPath, [nextBin, 'build', '--webpack'], {
      cwd: appDir,
      env: environment(false),
      stdio: 'pipe',
      // A hung build must fail the test, not block the run.
      timeout: 180_000,
    });
  }, 240_000);

  afterAll(() => {
    for (const child of children) child.kill('SIGKILL');
    if (appDir) rmSync(appDir, { recursive: true, force: true });
  });

  it('exits as soon as its HTTP server has closed, before the app has drained', async () => {
    const { code, elapsedMs, output } = await terminate({ holdExit: false });
    expect(output).toContain('drain started');
    expect(output).not.toContain('drain finished');
    expect(code).toBe(143);
    expect(elapsedMs).toBeLessThan(DRAIN_MS);
  }, 60_000);

  it('waits for the app to drain when its exit is held, and keeps its exit code', async () => {
    const { code, elapsedMs, output } = await terminate({ holdExit: true });
    expect(output).toContain('drain finished');
    expect(code).toBe(143);
    expect(elapsedMs).toBeGreaterThanOrEqual(DRAIN_MS);
    expect(elapsedMs).toBeLessThan(HTTP_GRACE_MS);
  }, 60_000);

  it('does not wait for a stream left open past the HTTP grace once the app has drained', async () => {
    const { code, elapsedMs, output } = await terminate({ holdExit: true, openStream: true });
    expect(output).toContain('drain finished');
    expect(code).toBe(143);
    expect(elapsedMs).toBeGreaterThanOrEqual(HTTP_GRACE_MS);
    expect(elapsedMs).toBeLessThan(HTTP_GRACE_MS + 5_000);
  }, 60_000);
});
