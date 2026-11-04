import 'server-only';
import type { Sandbox } from 'e2b';
import { SandboxError, sandboxConflict } from '@/lib/sandbox/errors';
import { shellQuote } from './command-runner';

export interface PreviewConnection {
  output: ReadableStream<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** SDK control-plane auth terminates at envd. No provider credential enters the app request. */
export const PREVIEW_RELAY = String.raw`
import socket, sys, threading, base64
s=socket.create_connection(('127.0.0.1',int(sys.argv[1])),timeout=15)
s.settimeout(120)
def incoming():
    try:
        while True:
            line=sys.stdin.buffer.readline(90000)
            if not line: break
            if not line.endswith(b'\n'): raise ValueError('frame size')
            s.sendall(base64.b64decode(line[:-1],validate=True))
    except Exception: pass
    finally:
        try: s.shutdown(socket.SHUT_WR)
        except OSError: pass
threading.Thread(target=incoming,daemon=True).start()
try:
    while True:
        data=s.recv(32768)
        if not data: break
        print(base64.b64encode(data).decode(),flush=True)
finally: s.close()
`;

const counts = new Map<string, number>();
/** Bounded, short-lived TCP relay over the existing SDK's command stdin/stdout. */
export async function openSdkPreviewConnection(
  sandbox: Sandbox,
  port: number,
  signal: AbortSignal,
  durationMs: number,
): Promise<PreviewConnection> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 49983)
    throw sandboxConflict('Invalid preview port.');
  const key = sandbox.sandboxId;
  if ((counts.get(key) ?? 0) >= 8 || [...counts.values()].reduce((a, b) => a + b, 0) >= 32)
    throw new SandboxError(
      'SANDBOX_PREVIEW_CAPACITY',
      429,
      'Preview connection limit reached. Close unused previews.',
    );
  counts.set(key, (counts.get(key) ?? 0) + 1);
  let handle: Awaited<ReturnType<Sandbox['commands']['connect']>> | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = '';
  let received = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const output = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel() {
        return close();
      },
    },
    { highWaterMark: 1024 * 1024, size: (chunk) => chunk.byteLength },
  );
  async function close(error?: Error) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    const n = (counts.get(key) ?? 1) - 1;
    if (n) counts.set(key, n);
    else counts.delete(key);
    try {
      if (error) controller.error(error);
      else controller.close();
    } catch {
      /* cancelled */
    }
    if (handle) {
      await handle.kill().catch(() => {});
      await handle.disconnect().catch(() => {});
    }
  }
  const abort = () => {
    void close();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    await close();
    throw sandboxConflict('Preview disconnected.');
  }
  try {
    handle = await sandbox.commands.run(`python3 -u -c ${shellQuote(PREVIEW_RELAY)} ${port}`, {
      background: true,
      stdin: true,
      timeoutMs: Math.max(1, Math.min(durationMs, 120000)),
      requestTimeoutMs: 30000,
      onStdout(data) {
        if (closed) return;
        pending += data;
        let at: number;
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (line.length > 45000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(line)) {
            void close(new Error('Invalid preview frame.'));
            return;
          }
          const bytes = Buffer.from(line, 'base64');
          received += bytes.length;
          if (received > 16 * 1024 * 1024) {
            void close(new Error('Preview response exceeds 16 MiB.'));
            return;
          }
          if ((controller.desiredSize ?? 0) < bytes.length) {
            void close(new Error('Preview reader is too slow.'));
            return;
          }
          controller.enqueue(bytes);
        }
        if (pending.length > 45000) void close(new Error('Preview frame exceeds limit.'));
      },
      onStderr() {
        /* Runtime failures are not reflected to the browser. */
      },
    });
    if (closed) {
      await handle.kill().catch(() => {});
      await handle.disconnect().catch(() => {});
      throw sandboxConflict('Preview disconnected.');
    }
    timer = setTimeout(abort, Math.max(1, Math.min(durationMs, 120000)));
    void handle.wait().then(
      () => close(),
      () => close(new Error('Preview connection ended.')),
    );
    return {
      output,
      async write(data) {
        if (closed || !handle) throw sandboxConflict('Preview connection ended.');
        for (let i = 0; i < data.length; i += 32768)
          await handle.sendStdin(
            Buffer.from(data.subarray(i, i + 32768)).toString('base64') + '\n',
            { requestTimeoutMs: 15000 },
          );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
