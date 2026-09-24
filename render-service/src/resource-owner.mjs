// Dedicated root resource owner. Admission stays in RenderCoordinator; this
// process owns only the active task's platform boundary and settlement.
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAncestorPressureMonitor } from './resource-ancestor-pressure.mjs';
import { runResourceTask } from './resource-systemd-runner.mjs';
import { readResourceSettings } from './resource-settings.mjs';

function notAdmitted() {
  return {
    published: false,
    cleanupVerified: true,
    reservationReturned: true,
    admissionClosed: false,
    details: { notAdmitted: true },
  };
}

function validOptions(options) {
  return (
    options &&
    typeof options === 'object' &&
    Number.isSafeInteger(options.fps) &&
    options.fps > 0 &&
    options.fps <= 120 &&
    ['draft', 'standard', 'high'].includes(options.quality) &&
    options.format === 'mp4'
  );
}

/** IPC request handling is exported so lifecycle/settlement can be tested locally. */
export function createResourceHandler({
  taskRunner,
  settings,
  send,
  close,
  admissionGuard = () => true,
}) {
  const projectRoot = realpathSync(settings.projectRoot);
  let active;
  let admissionClosed = false;
  const closeAdmission = () => {
    if (admissionClosed) return;
    admissionClosed = true;
    send({ event: 'closed' });
  };
  const handle = async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.event === 'cancel') {
      if (active?.id === message.id) active.abort.abort();
      return;
    }
    if (message.event !== 'render' || active || typeof message.id !== 'string') {
      closeAdmission();
      await close();
      return;
    }
    if (!admissionGuard()) {
      closeAdmission();
      send({
        event: 'result',
        id: message.id,
        result: {
          status: 'failed',
          failure: { code: 'execution_failed', message: 'Resource owner is unavailable' },
          resources: { ...notAdmitted(), admissionClosed: true },
        },
      });
      return;
    }
    const abort = new AbortController();
    let resolveDone;
    const done = new Promise((resolveDonePromise) => {
      resolveDone = resolveDonePromise;
    });
    active = { id: message.id, abort, done };
    let outcome;
    let invoked = false;
    try {
      if (Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024)
        throw new Error('Oversized resource request');
      if (typeof message.deadlineNs !== 'string' || !/^\d+$/.test(message.deadlineNs))
        throw new Error('Missing monotonic deadline');
      if (!Number.isSafeInteger(message.timeoutMs) || message.timeoutMs <= 0)
        throw new Error('Invalid task timeout');
      if (!validOptions(message.options)) throw new Error('Invalid render options');
      const project = realpathSync(message.projectDir);
      const projectIdentity = lstatSync(project);
      if (
        project !== message.projectDir ||
        dirname(project) !== projectRoot ||
        !projectIdentity.isDirectory() ||
        projectIdentity.uid !== settings.owner.workerUid ||
        message.outputPath !== join(project, 'output.mp4') ||
        resolve(message.outputPath) !== message.outputPath
      )
        throw new Error('Project/output is outside the service-owned request boundary');
      const remaining = Math.min(
        message.timeoutMs,
        Number((BigInt(message.deadlineNs) - process.hrtime.bigint()) / 1_000_000n),
      );
      if (!Number.isSafeInteger(remaining) || remaining <= 0)
        throw new Error('render_deadline_exceeded');
      invoked = true;
      outcome = await taskRunner(
        settings,
        {
          ...message,
          projectDir: project,
          projectIdentity: { dev: projectIdentity.dev, ino: projectIdentity.ino },
          timeoutMs: remaining,
        },
        abort.signal,
      );
      if (outcome.admissionClosed) admissionClosed = true;
      if (!admissionGuard()) closeAdmission();
    } catch (error) {
      console.error('Resource render failed:', error);
      const expired = /^\d+$/.test(String(message.deadlineNs ?? ''))
        ? process.hrtime.bigint() >= BigInt(message.deadlineNs)
        : false;
      outcome = invoked
        ? {
            status: abort.signal.aborted ? 'cancelled' : 'failed',
            failureCode: abort.signal.aborted
              ? 'cancelled'
              : expired
                ? 'deadline_exceeded'
                : 'execution_failed',
            published: false,
            cleanupVerified: false,
            reservationReturned: false,
            admissionClosed: true,
            details: { unexpectedOwnerFailure: true },
          }
        : {
            status: 'failed',
            failureCode: expired ? 'deadline_exceeded' : 'execution_failed',
            ...notAdmitted(),
          };
      if (invoked) admissionClosed = true;
    }
    const cancelled = outcome.status === 'cancelled' || abort.signal.aborted;
    const status =
      outcome.status === 'succeeded' ? 'succeeded' : cancelled ? 'cancelled' : 'failed';
    const result = {
      status,
      ...(status === 'succeeded'
        ? {}
        : {
            failure: {
              code:
                status === 'cancelled'
                  ? 'cancelled'
                  : outcome.failureCode === 'deadline_exceeded'
                    ? 'deadline_exceeded'
                    : 'execution_failed',
              message:
                status === 'cancelled'
                  ? 'Render cancelled'
                  : outcome.failureCode === 'deadline_exceeded'
                    ? 'Render exceeded the deadline'
                    : 'Resource render failed; see service logs',
            },
          }),
      resources: {
        published: outcome.published === true,
        cleanupVerified: outcome.cleanupVerified === true,
        reservationReturned: outcome.reservationReturned === true,
        admissionClosed: admissionClosed || outcome.admissionClosed === true,
        ...(typeof outcome.diagnosticCode === 'string'
          ? { diagnosticCode: outcome.diagnosticCode }
          : {}),
        details: outcome.details ?? {},
      },
    };
    active = undefined;
    resolveDone();
    send({ event: 'result', id: message.id, result });
  };
  return Object.assign(handle, {
    accepting: () => !admissionClosed,
    closeAdmission,
    async shutdown() {
      admissionClosed = true;
      if (active) {
        active.abort.abort();
        await active.done;
      }
    },
  });
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !process.send)
    throw new Error('Resource owner requires Linux root and inherited IPC');
  const settings = readResourceSettings(process.argv[2]);
  const pressure = createAncestorPressureMonitor();
  if (!pressure.check()) throw new Error('Cannot verify ancestor pressure at owner startup');
  const runtimeSettings = {
    ...settings,
    owner: { ...settings.owner, taskSlice: pressure.taskSlice },
  };
  let closing = false;
  const send = (value) => {
    if (process.connected)
      process.send(value, (error) => {
        if (error) void close();
      });
  };
  let handle;
  async function close() {
    if (closing) return;
    closing = true;
    try {
      pressure.stop();
      await handle?.shutdown();
      rmSync(join(settings.stateRoot, 'owner.lock'), { recursive: true });
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }
  handle = createResourceHandler({
    taskRunner: runResourceTask,
    settings: runtimeSettings,
    send,
    close,
    admissionGuard: pressure.check,
  });
  pressure.start(() => handle.closeAdmission());
  process.once('disconnect', () => void close());
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  process.on('message', (message) => {
    if (!closing) void handle(message).catch(() => close());
  });
  send({ event: 'ready' });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
