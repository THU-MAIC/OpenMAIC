// Dedicated root S. The HTTP process drops privileges after this owner is ready.
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readResourceSettings } from './resource-settings.mjs';
import { verifyResourcePackage } from '../scripts/resource-package.mjs';

/** The same request handler used by S; native ownership stays in Producer. */
export function createResourceHandler({
  producer,
  settings,
  createRenderRequest,
  BudgetedRenderError,
  send,
  close,
}) {
  const projectRoot = realpathSync(settings.projectRoot);
  let active;
  return async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.event === 'cancel') {
      if (active?.id === message.id) active.abort.abort();
      return;
    }
    if (message.event !== 'render' || active || typeof message.id !== 'string') {
      await close();
      return;
    }
    const abort = new AbortController();
    active = { id: message.id, abort };
    let result;
    let deadlineNs;
    let invoked = false;
    try {
      if (Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024)
        throw new Error('Oversized resource request');
      if (typeof message.deadlineNs !== 'string' || !/^\d+$/.test(message.deadlineNs))
        throw new Error('Missing monotonic deadline');
      deadlineNs = BigInt(message.deadlineNs);
      const project = realpathSync(message.projectDir);
      if (
        project !== message.projectDir ||
        dirname(project) !== projectRoot ||
        lstatSync(project).uid !== settings.owner.workerUid ||
        message.outputPath !== join(project, 'output.mp4') ||
        resolve(message.outputPath) !== message.outputPath
      )
        throw new Error('Project/output is outside the service-owned request boundary');
      const request = createRenderRequest({
        projectDir: project,
        outputPath: message.outputPath,
        options: {
          fps: { num: message.options.fps, den: 1 },
          quality: message.options.quality,
          format: 'mp4',
          workers: 1,
        },
      });
      const remaining = Math.min(
        message.timeoutMs,
        Number((deadlineNs - process.hrtime.bigint()) / 1_000_000n),
      );
      if (!Number.isSafeInteger(remaining) || remaining <= 0)
        throw new Error('render_deadline_exceeded');
      invoked = true;
      const value = await producer.render(request, settings.task, {
        timeoutMs: remaining,
        signal: abort.signal,
      });
      result = {
        status: 'succeeded',
        resources: {
          published: true,
          cleanupVerified: value.reservationReturned,
          reservationReturned: value.reservationReturned,
          admissionClosed: producer.status().closed,
          details: value,
        },
      };
    } catch (error) {
      console.error('Resource render failed:', error);
      const details =
        error instanceof BudgetedRenderError
          ? error.settlement
          : invoked
            ? { unexpectedFailure: true }
            : {
                published: false,
                cleanupVerified: true,
                reservationReturned: true,
                notAdmitted: true,
              };
      const cancelled = abort.signal.aborted;
      const expired = deadlineNs !== undefined && process.hrtime.bigint() >= deadlineNs;
      result = {
        status: cancelled ? 'cancelled' : 'failed',
        failure: {
          code: cancelled ? 'cancelled' : expired ? 'deadline_exceeded' : 'execution_failed',
          message: cancelled
            ? 'Render cancelled'
            : expired
              ? 'Render exceeded the deadline'
              : 'Resource render failed; see service logs',
        },
        resources: {
          published: details.published === true,
          cleanupVerified: details.cleanupVerified === true,
          reservationReturned: details.reservationReturned === true,
          admissionClosed:
            producer.status().closed || (invoked && !(error instanceof BudgetedRenderError)),
          details,
        },
      };
    }
    active = undefined;
    send({ event: 'result', id: message.id, result });
  };
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !process.send)
    throw new Error('Resource owner requires Linux root and inherited IPC');
  const settings = readResourceSettings(process.argv[2]);
  const packageRoot = verifyResourcePackage(settings.packageRoot);
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@hyperframes/producer' || manifest.version !== '0.8.37')
    throw new Error('Expected the fixed patched Producer 0.8.37');
  const { createBudgetedProducer, BudgetedRenderError } = await import(
    pathToFileURL(join(packageRoot, 'dist/resources.js')).href
  );
  const { createRenderRequest } = await import(
    pathToFileURL(join(packageRoot, 'dist/index.js')).href
  );
  const producer = createBudgetedProducer({ ...settings.owner, maxActive: 1, maxQueued: 0 });
  let closing = false;
  const send = (value) => {
    if (process.connected)
      process.send(value, (error) => {
        if (error) void close();
      });
  };
  const statusTimer = setInterval(() => {
    if (producer.status().closed) {
      send({ event: 'closed' });
      clearInterval(statusTimer);
    }
  }, 100).unref();
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(statusTimer);
    try {
      await producer.close();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }
  process.once('disconnect', () => void close());
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  const handle = createResourceHandler({
    producer,
    settings,
    createRenderRequest,
    BudgetedRenderError,
    send,
    close,
  });
  process.on('message', (message) => {
    if (!closing) void handle(message).catch(() => close());
  });
  if (producer.status().closed) {
    await producer.close();
    throw new Error('Ancestor pressure prevents startup');
  }
  send({ event: 'ready' });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
