/**
 * Process-scoped startup work.
 *
 * Next calls `register` once per server instance, before it serves a request.
 * That makes it the only place in this app where a background schedule can
 * live: a route module has no such guarantee — it can be instantiated more than
 * once and gets no shutdown hook — so anything periodic started from one is
 * really started per instantiation.
 *
 * `register` must return before the server is ready, so nothing here may block
 * on I/O. Starting a timer does not.
 */
export async function register(): Promise<void> {
  // Also invoked for the Edge runtime, which has neither `pg` nor timers we
  // want; the persistence stack is Node-only. The Node implementation lives in
  // its own dynamically-imported module so Next.js's Edge static analysis does
  // not flag `process.once` on `instrumentation.ts`.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
  await registerNodeInstrumentation();
}
