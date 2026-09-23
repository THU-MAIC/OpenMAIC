import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { RenderExecutor } from './render-executor.js';
import type {
  RenderExecutionRequest,
  RenderExecutionResult,
  RenderResourceSettlement,
} from './types.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const resourceDiagnosticCodes = new Set([
  'main_pid_fields_not_ready',
  'main_pid_startup_transient',
  'main_pid_process_exited',
  'main_pid_read_error',
  'main_pid_identity_mismatch',
]);
function settlement(value: unknown): value is RenderResourceSettlement {
  return (
    record(value) &&
    ['cleanupVerified', 'reservationReturned', 'admissionClosed'].every(
      (key) => typeof value[key] === 'boolean',
    ) &&
    (typeof value.published === 'boolean' || value.published === 'unknown') &&
    (value.diagnosticCode === undefined ||
      (typeof value.diagnosticCode === 'string' &&
        resourceDiagnosticCodes.has(value.diagnosticCode))) &&
    record(value.details)
  );
}
function result(value: unknown): value is RenderExecutionResult {
  if (!record(value) || !settlement(value.resources)) return false;
  if (value.status === 'succeeded') return value.resources.published === true;
  if (!record(value.failure) || typeof value.failure.message !== 'string') return false;
  return value.status === 'cancelled'
    ? value.failure.code === 'cancelled'
    : value.status === 'failed' &&
        ['deadline_exceeded', 'execution_failed'].includes(String(value.failure.code));
}

/** Transport to the dedicated root resource owner; no resource ledger lives here. */
export class ResourceClient implements RenderExecutor {
  private available = false;
  private terminal = false;
  private started = false;
  private pending?: { id: string; finish: (value: RenderExecutionResult) => void };
  readonly ready: Promise<void>;
  private readonly exited: Promise<number | null>;

  constructor(
    private readonly child: ChildProcess,
    private readonly cleanupMs: number,
  ) {
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Resource owner startup timed out'));
        this.fail();
      }, 10_000);
      const failReady = () => {
        clearTimeout(timer);
        reject(new Error('Resource owner exited before ready; see service logs'));
      };
      child.once('exit', failReady);
      child.once('error', failReady);
      child.on('message', (message: unknown) => {
        if (!record(message) || Buffer.byteLength(JSON.stringify(message)) > 1024 * 1024) {
          this.fail();
          return;
        }
        if (message.event === 'ready' && !this.terminal && !this.started) {
          clearTimeout(timer);
          child.removeListener('exit', failReady);
          child.removeListener('error', failReady);
          this.started = true;
          this.available = true;
          resolve();
          return;
        }
        if (message.event === 'closed') {
          this.available = false;
          return;
        }
        if (
          message.event === 'result' &&
          typeof message.id === 'string' &&
          result(message.result)
        ) {
          const item = this.pending;
          if (!item || item.id !== message.id) {
            this.fail();
            return;
          }
          if (
            message.result.resources?.admissionClosed ||
            message.result.resources?.cleanupVerified === false ||
            message.result.resources?.reservationReturned === false
          )
            this.available = false;
          item.finish(message.result);
          return;
        }
        this.fail();
      });
    });
    child.once('exit', () => this.fail());
    child.once('error', () => this.fail());
    child.once('disconnect', () => this.fail());
  }

  accepting(): boolean {
    return this.available && !this.terminal;
  }

  private fail(): void {
    this.available = false;
    this.terminal = true;
    this.pending?.finish({
      status: 'failed',
      failure: {
        code: 'execution_failed',
        message: 'Resource owner lost; platform cleanup required.',
      },
      resources: {
        published: 'unknown',
        cleanupVerified: false,
        reservationReturned: false,
        admissionClosed: true,
        details: { ownerLost: true },
      },
    });
    // Closing the inherited lifeline makes the owner stop admitting work. The
    // systemd task remains independently bounded; never claim that a transport
    // timeout drained it or returned its reservation.
    if (this.child.connected) this.child.disconnect();
  }

  private send(message: object): void {
    try {
      this.child.send(message, (error) => {
        if (error) this.fail();
      });
    } catch {
      // A synchronous transport failure is also an unknown terminal boundary.
      this.fail();
    }
  }

  async execute(request: RenderExecutionRequest): Promise<RenderExecutionResult> {
    const deadlineNs = process.hrtime.bigint() + BigInt(request.deadlineMs) * 1_000_000n;
    if (request.signal.aborted)
      return { status: 'cancelled', failure: { code: 'cancelled', message: 'Render cancelled' } };
    if (!this.accepting() || this.pending)
      return {
        status: 'failed',
        failure: { code: 'execution_failed', message: 'Resource owner is unavailable' },
      };
    if (request.chunkExecution)
      return {
        status: 'failed',
        failure: {
          code: 'execution_failed',
          message: 'Budgeted rendering supports local file output, not chunk execution',
        },
      };
    await request.onProgress({ progress: 0, stage: 'preparing' });
    if (!this.accepting() || this.pending || request.signal.aborted)
      return request.signal.aborted
        ? { status: 'cancelled', failure: { code: 'cancelled', message: 'Render cancelled' } }
        : {
            status: 'failed',
            failure: { code: 'execution_failed', message: 'Resource owner is unavailable' },
          };
    if (process.hrtime.bigint() >= deadlineNs)
      return {
        status: 'failed',
        failure: { code: 'deadline_exceeded', message: 'Render exceeded the deadline' },
      };
    return new Promise((resolve) => {
      const id = randomUUID();
      const abort = () => {
        if (this.child.connected) this.send({ event: 'cancel', id });
      };
      const timer = setTimeout(() => this.fail(), request.deadlineMs + 2 * this.cleanupMs + 5000);
      const finish = (value: RenderExecutionResult) => {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', abort);
        this.pending = undefined;
        resolve(value);
      };
      this.pending = { id, finish };
      request.signal.addEventListener('abort', abort, { once: true });
      this.send({
        event: 'render',
        id,
        projectDir: request.projectDir,
        outputPath: request.outputPath,
        options: request.options,
        timeoutMs: request.deadlineMs,
        deadlineNs: String(deadlineNs),
      });
      if (request.signal.aborted) abort();
    });
  }

  async close(): Promise<void> {
    this.available = false;
    if (this.child.connected) this.child.disconnect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('Resource owner shutdown unverified; platform takeover required')),
            2 * this.cleanupMs + 5000,
          );
        }),
      ]);
      if (code !== 0)
        throw new Error('Resource owner did not exit cleanly; platform takeover required');
    } finally {
      clearTimeout(timer);
    }
  }
}
